import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
const execPromise = promisify(exec);

// --- 配置 ---
const isDel = true;
const BASE_DIR = "D:\\04_Temp\\直播";
const TARGET_DIR = path.join(BASE_DIR, "快手直播"); // 目标目录，按需修改
const OUTPUT_DIR = BASE_DIR; // 输出目录
const FFMPEG_CMD = 'ffmpeg';
const FFPROBE_CMD = 'ffprobe';
const LOG_FILE = path.join(BASE_DIR, "conversion.log");
const MANUAL_REVIEW_FILE = path.join(BASE_DIR, "manual_review.txt"); // 无法自动通过时记录原 .flv 路径
const extensionsToConvert = ['.ts', '.flv'];
// 设定最小可用空间阈值和转换文件的限制
const SPACE_THRESHOLD = 5 * 1024 * 1024 * 1024; // 可用空间最小 5 GB
const MAX_BATCH_SIZE_BYTES = 70 * 1024 * 1024 * 1024; // 每批次最大 20 GB
const MAX_DIFF_SIZE_BYTES = 2 * 1024 * 1024; // 差异最大 2 MB
// --------------------

/**
 * 写日志到文件并在控制台打印
 * @param {string} message 日志内容
 * @param {'DEBUG'|'INFO'|'WARNING'|'ERROR'|'CRITICAL'} [level='INFO'] 日志级别
 * @default level 'INFO'
 */
function writeLog(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logEntry = message === '\n' ? message : `[${timestamp}] [${level}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logEntry, 'utf8');
  if (level !== 'DEBUG') {
    console.log(message === '\n' ? message : `[${level}] ${message}`);
  }
}

/**
 * 获取指定目录的可用磁盘空间（字节数）
 * @param {string} directory 要检查的目录路径
 * @returns {number} 返回可用磁盘空间（字节数），如果获取失败则返回 0
 */
function getAvailableDiskSpace(directory) {
  const platform = process.platform;
  let command;
  let args = [];
  // 针对不同平台使用不同的命令
  if (platform === 'win32') {
    command = 'fsutil';
    args = ['volume', 'diskfree', directory.split(path.sep)[0] + '\\'];
  } else {
    throw new Error('Unsupported platform');
  }

  // 执行系统命令并获取输出
  const result = spawnSync(command, args, { encoding: 'utf8' }); // 使用第三方库 iconv-lite 能正确解码
  if (result.error) {
    writeLog(`获取目录所在磁盘空间时发生错误: ${directory} 。错误: ${result.error}`, 'ERROR');
    return 0;
  }

  // 解析命令输出提取可用空间
  const output = result.stdout;
  if (platform === 'win32') {
    // 使用正则表达式提取数字
    const freeSpaceMatch = output.match(/([\d,]+)/);
    if (freeSpaceMatch) {
      // 去掉数字中的千分位符号（,），并将其转换为整数
      const freeSpaceInBytes = parseInt(freeSpaceMatch[0].replace(/,/g, ''), 10);
      console.log('可用空间:', (freeSpaceInBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB');
      return freeSpaceInBytes;
    }
  } else {
    throw new Error('Unsupported platform');
  }

  return 0;
}

/**
 * 递归收集指定目录下需要转换的文件，限制每批次文件总大小，并按修改时间递增排序
 * @param {string} dir 目录路径
 * @returns {string[]} 按修改时间 mtime 递增排序后的待转换文件绝对路径数组
 */
function collectFiles(dir) {
  const fileList = [];
  let totalSize = 0;

  function walk(currentDir) {
    const files = fs.readdirSync(currentDir);
    for (const file of files) {
      const fullPath = path.join(currentDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        // 如果子目录返回 true（表示已达上限），就向上立即返回停止信号
        if (walk(fullPath)) return true;
        continue;
      }
      const ext = path.extname(file).toLowerCase();
      if (!extensionsToConvert.includes(ext)) continue;

      // 超过限制 => 发出停止信号（不直接返回 fileList）
      if (totalSize + stat.size > MAX_BATCH_SIZE_BYTES) return true;

      totalSize += stat.size;
      fileList.push({
        fullPath,
        size: stat.size,
        mtime: stat.mtime, // 修改时间
        atime: stat.atime // 访问时间
      });
    }
    return false; // 本目录正常结束，未触发停止
  }
  // 启动递归收集（walk 会在必要时返回 true）
  walk(dir);

  writeLog(`本批次将处理 ${fileList.length} 个文件，大小合计 ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`, 'INFO');
  writeLog(`\n`);

  // 按文件修改时间递增排序
  fileList.sort((a, b) => a.mtime - b.mtime);

  return fileList; // 始终返回数组
}

/**
 * 使用 ffprobe 获取媒体文件的 JSON 信息
 * 等效于：ffprobe -v quiet -print_format json=c=1 -show_format -show_streams "file"
 * @param {string} filePath 媒体文件路径
 * @returns {Promise<object|null>} ffprobe 输出解析后的 JSON，失败返回 null
 */
async function runFfprobeJson(filePath) {
  const cmd = `${FFPROBE_CMD} -v quiet -print_format json=c=1 -show_format -show_streams "${filePath}"`;
  try {
    // 用 exec + await：快速拿到元信息
    const { stdout } = await execPromise(cmd, { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    writeLog(`ffprobe 执行失败: ${filePath} 。错误: ${err.message}`, 'ERROR');
    return null;
  }
}

/**
 * 根据用户指定的 5 项“必须核心条件”验证 mp4
 * 条件：
 * a) format.format_name 包含 mp4
 * b) 存在 video 流 codec_name === 'h264' && codec_tag_string 包含 'avc1'
 * c) 存在 audio 流 codec_name === 'aac' && codec_tag_string 包含 'mp4a'
 * d) format.nb_streams >= 2
 * e) format.duration 存在且为正数
 * f) format.size 与转换前大小差异不超过 MAX_DIFF_SIZE_BYTES
 * @param {any} ffinfo ffprobe 返回的 JSON
 * @returns {{ok:boolean,reasons:string[],details:object}} 验证结果
 */
function validateMp4ByFfprobe(ffinfo, originSize) {
  if (!ffinfo || !ffinfo.format || !ffinfo.streams) return { ok: false, reason: 'missing format or streams' };
  const fmt = ffinfo.format || {};
  const streams = ffinfo.streams || [];

  const a_ok = fmt.format_name.includes('mp4');

  const video_ok = streams.some(
    (s) => s.codec_type === 'video' && s.codec_name === 'h264' && typeof s.codec_tag_string === 'string' && s.codec_tag_string.includes('avc1')
  );
  const audio_ok = streams.some(
    (s) => s.codec_type === 'audio' && s.codec_name === 'aac' && typeof s.codec_tag_string === 'string' && s.codec_tag_string.includes('mp4a')
  );

  const nb_streams = typeof fmt.nb_streams === 'number' ? fmt.nb_streams : parseInt(fmt.nb_streams || '0', 10);
  const d_ok = nb_streams >= 2;

  const duration = parseFloat(fmt.duration || 0);
  const e_ok = duration > 0;

  const size = parseFloat(fmt.size || 0);
  const f_ok = Math.abs(size, originSize) > MAX_DIFF_SIZE_BYTES;

  const ok = a_ok && video_ok && audio_ok && d_ok && e_ok && f_ok;
  const reasons = [];
  if (!a_ok) reasons.push('container_not_mp4');
  if (!video_ok) reasons.push('video_stream_not_h264_avc1');
  if (!audio_ok) reasons.push('audio_stream_not_aac_mp4a');
  if (!d_ok) reasons.push('nb_streams_lt_2');
  if (!e_ok) reasons.push('duration_invalid');
  if (!f_ok) reasons.push('size_invalid');

  return { ok, reasons, details: { a_ok, video_ok, audio_ok, nb_streams, duration, size } };
}

/**
 * 将单个 .flv（或 .ts）文件通过 ffmpeg -c copy 转为 mp4，并根据 ffprobe 输出验证结果
 * 如果验证通过：复制时间戳，删除原始文件
 * 如果验证不通过：删除生成的 mp4，并将原始文件路径写入人工审查清单
 * @param {string} inputPath 要转换的文件路径
 * @returns {Promise<void>}
 */
async function convertFlvToMp4({ fullPath: inputPath, size: originSize, mtime, atime }) {
  const filename = path.basename(inputPath, path.extname(inputPath)) + '.mp4';
  const outputPath = path.join(OUTPUT_DIR, filename);

  if (fs.existsSync(outputPath)) {
    writeLog(`跳过: 目标文件已存在。${outputPath}`, 'WARNING');
    try {
      if (isDel) {
        fs.unlinkSync(inputPath);
        writeLog(`删除原文件: ${inputPath}`, 'INFO');
      }
    } catch (delErr) {
      writeLog(`警告: 删除原文件失败: ${inputPath}。错误: ${delErr.message}`, 'WARNING');
    }
    writeLog(`\n`);
    return;
  }

  writeLog(`开始转换: ${inputPath} -> ${outputPath}`);

  const args = ['-loglevel', 'error', '-i', inputPath, '-c', 'copy', '-fflags', '+genpts', '-movflags', '+faststart', outputPath];

  await new Promise((resolve) => {
    // 用 spawn：启动转码，实时监控
    const ffmpeg = spawn(FFMPEG_CMD, args, { windowsHide: true });

    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        writeLog(`ffmpeg: 转换完成 -> ${outputPath}`, 'INFO');

        const ffinfo = await runFfprobeJson(outputPath);
        const validation = validateMp4ByFfprobe(ffinfo, originSize);

        if (validation.ok) {
          writeLog(`验证通过: ${outputPath} (可正常播放概率 99.9%)`, 'INFO');

          if (mtime && atime) {
            try {
              fs.utimesSync(outputPath, atime, mtime);
              writeLog(`时间戳已复制到新文件: ${outputPath}`, 'INFO');
            } catch (utimesError) {
              writeLog(`警告: 复制时间戳失败。错误: ${utimesError.message}`, 'WARNING');
            }
          }

          try {
            if (isDel) {
              fs.unlinkSync(inputPath);
              writeLog(`删除原文件: ${inputPath}`, 'INFO');
            }
          } catch (delErr) {
            writeLog(`警告: 删除原文件失败: ${inputPath}。错误: ${delErr.message}`, 'WARNING');
          }
        } else {
          try {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
              writeLog(`删除未通过验证的输出文件: ${outputPath}`, 'WARNING');
            }
          } catch (e) {
            writeLog(`警告: 删除未通过验证的输出文件失败: ${outputPath}。错误: ${e.message}`, 'WARNING');
          }

          const reasonText = `文件: ${inputPath} 未通过自动验证。原因: ${validation.reasons.join(', ')}`;
          fs.appendFileSync(MANUAL_REVIEW_FILE, reasonText, 'utf8');
          writeLog(`记录到人工审查清单: ${inputPath}`, 'WARNING');
        }
      } else {
        writeLog(`转换失败: ${inputPath}。ffmpeg 返回代码: ${code}`, 'ERROR');
        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
            writeLog(`删除损坏的输出文件: ${outputPath}`, 'INFO');
          } catch (e) {
            writeLog(`警告: 删除损坏的输出文件失败: ${outputPath}。错误: ${e.message}`, 'WARNING');
          }
        }
      }
      writeLog(`\n`);
      resolve();
    });

    ffmpeg.on('error', (err) => {
      writeLog(`ffmpeg 进程错误: ${err.message}`, 'CRITICAL');
      writeLog(`\n`);
      resolve();
    });
  });
}

/**
 * 主流程：收集文件、检查磁盘空间并批量处理文件
 * 
 * @async
 * @returns {Promise<void>} 无返回值，处理过程中遇到问题会通过日志记录
 */
async function main() {
  console.log('--- 视频批量流复制转换工具 (Node.js + FFmpeg) ---');
  console.log(`目标目录: ${TARGET_DIR}`);
  console.log(`输出目录: ${OUTPUT_DIR}`);
  console.log(`日志文件: ${LOG_FILE}`);
  console.log(`人工审查清单: ${MANUAL_REVIEW_FILE}`);
  console.log('-----------------------------------------');

  fs.writeFileSync(LOG_FILE, `--- 视频批量流复制转换日志 ---
`, 'utf8');

  if (!fs.existsSync(TARGET_DIR)) {
    writeLog(`【致命错误】目标目录不存在: ${TARGET_DIR}。`, 'CRITICAL');
    return;
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  if (fs.existsSync(MANUAL_REVIEW_FILE)) {
    fs.unlinkSync(MANUAL_REVIEW_FILE);
  }
  // 获取磁盘可用空间
  const availableSpace = getAvailableDiskSpace(OUTPUT_DIR);
  if (availableSpace < SPACE_THRESHOLD) {
    writeLog(`【致命错误】输出目录(${OUTPUT_DIR})所在磁盘空间不足，剩余空间低于阈值，停止转换。`, 'CRITICAL');
    return;
  }

  // 收集待转换文件
  const filesToConvert = collectFiles(TARGET_DIR);

  for (const fileInfo of filesToConvert) {
    // 顺序执行，避免并发导致 I/O 竞争或 ffmpeg 资源冲突
    await convertFlvToMp4(fileInfo);
  }

  console.log('-----------------------------------------');
  writeLog(`转换任务完成。共尝试处理 ${filesToConvert.length} 个文件。`, 'INFO');
  console.log(`详情请查看 ${LOG_FILE} ，未通过验证的文件记录在 ${MANUAL_REVIEW_FILE}`);
}

main()