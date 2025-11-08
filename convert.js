import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execPromise = promisify(exec);

// --- 配置 ---
const BASE_DIR = "D:\\04_Temp\\直播";
const TARGET_DIR = path.join(BASE_DIR, "抖音直播");  // 目标目录，按需修改
const OUTPUT_DIR = BASE_DIR;  // 输出目录
const FFMPEG_CMD = 'ffmpeg';
const FFPROBE_CMD = 'ffprobe';
const LOG_FILE = path.join(BASE_DIR, "conversion.log");
const MANUAL_REVIEW_FILE = path.join(BASE_DIR, "manual_review.txt");  // 无法自动通过时记录原 .flv 路径
const extensionsToConvert = ['.ts', '.flv'];
const isDel = true;
// --------------------

/**
 * 写日志到文件并在控制台打印（简洁模式）
 * @param {string} message 日志内容
 * @param {'DEBUG'|'INFO'|'WARNING'|'ERROR'|'CRITICAL'} [level='INFO'] 日志级别
 */
function writeLog(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logEntry, 'utf8');
  if (level !== 'DEBUG') {
    console.log(`[${level}] ${message.split('')[0]}`);
  }
}

/**
 * 递归收集指定目录下需要转换的文件
 * @param {string} dir 目录路径
 * @param {string[]} [fileList=[]]
 * @returns {string[]} 待转换文件绝对路径数组
 */
function collectFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      collectFiles(fullPath, fileList);
    } else {
      const ext = path.extname(file).toLowerCase();
      if (extensionsToConvert.includes(ext)) fileList.push(fullPath);
    }
  }
  return fileList;
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
 * @param {any} ffinfo ffprobe 返回的 JSON
 * @returns {{ok:boolean,reasons:string[],details:object}} 验证结果
 */
function validateMp4ByFfprobe(ffinfo) {
  if (!ffinfo || !ffinfo.format || !ffinfo.streams) return { ok: false, reason: 'missing_format_or_streams' };
  const fmt = ffinfo.format || {};
  const streams = ffinfo.streams || [];

  const a_ok = typeof fmt.format_name === 'string' && fmt.format_name.includes('mp4');

  const video_ok = streams.some(
    (s) => s.codec_type === 'video' && s.codec_name === 'h264' && typeof s.codec_tag_string === 'string' && s.codec_tag_string.includes('avc1')
  );
  const audio_ok = streams.some(
    (s) => s.codec_type === 'audio' && s.codec_name === 'aac' && typeof s.codec_tag_string === 'string' && s.codec_tag_string.includes('mp4a')
  );

  const nb_streams = typeof fmt.nb_streams === 'number' ? fmt.nb_streams : parseInt(fmt.nb_streams || '0', 10);
  const d_ok = !Number.isNaN(nb_streams) && nb_streams >= 2;

  const duration = parseFloat(fmt.duration || 0);
  const e_ok = !Number.isNaN(duration) && duration > 0;

  const ok = a_ok && video_ok && audio_ok && d_ok && e_ok;
  const reasons = [];
  if (!a_ok) reasons.push('container_not_mp4');
  if (!video_ok) reasons.push('video_stream_not_h264_avc1');
  if (!audio_ok) reasons.push('audio_stream_not_aac_mp4a');
  if (!d_ok) reasons.push('nb_streams_lt_2');
  if (!e_ok) reasons.push('duration_invalid');

  return { ok, reasons, details: { a_ok, video_ok, audio_ok, nb_streams, duration } };
}

/**
 * 将单个 .flv（或 .ts）文件通过 ffmpeg -c copy 转为 mp4，并根据 ffprobe 输出验证结果
 * 如果验证通过：复制时间戳，删除原始文件
 * 如果验证不通过：删除生成的 mp4，并将原始文件路径写入人工审查清单
 * @param {string} inputPath 要转换的文件路径
 * @returns {Promise<void>}
 */
async function convertFlvToMp4(inputPath) {
  const filename = path.basename(inputPath, path.extname(inputPath)) + '.mp4';
  const outputPath = path.join(OUTPUT_DIR, filename);

  if (fs.existsSync(outputPath)) {
    writeLog(`跳过: 目标文件已存在。${outputPath}`, 'WARNING');
    return;
  }

  let originalMtime, originalAtime;
  try {
    const stats = fs.statSync(inputPath);
    originalMtime = stats.mtime;
    originalAtime = stats.atime;
  } catch (e) {
    writeLog(`警告: 无法读取原文件时间戳。错误: ${e.message}`, 'WARNING');
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
        const validation = validateMp4ByFfprobe(ffinfo);

        if (validation.ok) {
          writeLog(`验证通过: ${outputPath} (可正常播放概率 99.9%)`, 'INFO');

          if (originalMtime && originalAtime) {
            try {
              fs.utimesSync(outputPath, originalAtime, originalMtime);
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
            writeLog(`警告: 删除输出文件失败: ${outputPath}。错误: ${e.message}`, 'WARNING');
          }

          const reasonText = `文件: ${inputPath} 未通过自动验证。原因: ${validation.reasons.join(', ')}
`;
          fs.appendFileSync(MANUAL_REVIEW_FILE, reasonText, 'utf8');
          writeLog(`记录到人工审查清单: ${inputPath}`, 'WARNING');
        }
      } else {
        writeLog(`转换失败: ${inputPath}。ffmpeg 返回代码: ${code}`, 'ERROR');
        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
            writeLog(`删除损坏输出文件: ${outputPath}`, 'INFO');
          } catch (e) {
            /* 忽略 */
          }
        }
      }
      resolve();
    });

    ffmpeg.on('error', (err) => {
      writeLog(`ffmpeg 进程错误: ${err.message}`, 'CRITICAL');
      resolve();
    });
  });
}

/**
 * 主流程：扫描目录并顺序转换
 * @returns {Promise<void>}
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

  const filesToConvert = collectFiles(TARGET_DIR);
  console.log(`共找到 ${filesToConvert.length} 个待处理文件。`);

  for (const file of filesToConvert) {
    // 顺序执行，避免并发导致 I/O 竞争或 ffmpeg 资源冲突
    await convertFlvToMp4(file);
  }

  console.log('-----------------------------------------');
  writeLog(`转换任务完成。共尝试处理 ${filesToConvert.length} 个文件。`, 'INFO');
  console.log(`详情请查看 ${LOG_FILE}，未通过自动验证的文件已记录在 ${MANUAL_REVIEW_FILE}`);
}

main()