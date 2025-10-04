const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process'); 
const util = require('util');
const execPromise = util.promisify(exec); // 将 exec 包装成 Promise 版本

// --- 配置 ---
// 目标目录：请修改为您要处理的根目录
// const TARGET_DIR = path.resolve(process.cwd(), "VideosToConvert"); // 默认在脚本所在目录创建 "VideosToConvert" 文件夹
const TARGET_DIR = "D:\\04_Temp\\直播";

// FFmpeg 命令：如果 ffmpeg.exe 不在系统路径中，请修改为完整路径
const FFMPEG_CMD = 'ffmpeg'; 

// 日志文件路径
const LOG_FILE = 'conversion.log';
// --------------------

// 全局变量用于存储总时长，方便计算进度
let totalDurationSeconds = 0; 
const extensionsToConvert = ['.ts', '.flv'];

/**
 * 写入日志文件
 * @param {string} message - 日志消息
 * @param {string} level - 日志级别 (INFO, ERROR, WARNING)
 */
function writeLog(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logEntry, 'utf8');
    // 只在控制台显示非调试信息
    if (level !== 'DEBUG') {
        console.log(`[${level}] ${message.split('\n')[0]}`);
    }
}

/**
 * 查找和收集目标文件
 * @param {string} dir - 当前目录
 * @param {Array<string>} fileList - 文件列表引用
 */
function collectFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);

    files.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            collectFiles(fullPath, fileList);
        } else {
            const ext = path.extname(file).toLowerCase();
            if (extensionsToConvert.includes(ext)) {
                fileList.push(fullPath);
            }
        }
    });

    return fileList;
}

/**
 * 提取视频时长 (Duration)
 * @param {string} inputPath - 输入文件路径
 * @returns {Promise<number>} - 视频总时长（秒）
 */
function getDuration(inputPath) {
    return new Promise((resolve) => {
        // 使用 FFmpeg 快速检查输入文件信息
        const command = `${FFMPEG_CMD} -i "${inputPath}"`;
        
        execPromise(command)
            .then(() => resolve(0)) // 理论上成功执行不会进入，但避免阻塞
            .catch((error) => {
                // FFmpeg 遇到错误时，时长信息通常在 stderr 中
                const stderr = error.stderr || error.message;
                const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                if (match) {
                    const [, hours, minutes, seconds, hundredths] = match;
                    const durationInSeconds = 
                        parseInt(hours) * 3600 + 
                        parseInt(minutes) * 60 + 
                        parseInt(seconds) + 
                        parseInt(hundredths) / 100;
                    return resolve(durationInSeconds);
                }
                writeLog(`无法获取时长: ${inputPath}`, 'WARNING');
                return resolve(0); 
            });
    });
}


/**
 * 执行视频流复制转换并显示进度
 * @param {string} inputPath - 输入文件路径
 */
function convertVideoStreamCopy(inputPath) {
    const outputBase = inputPath.substring(0, inputPath.lastIndexOf(path.extname(inputPath)));
    const outputPath = outputBase + '.mp4';
    
    // 进度条显示函数
    const renderProgress = (time, total) => {
        const progress = Math.min(1, time / total);
        const barLength = 50;
        const filled = Math.round(barLength * progress);
        const empty = barLength - filled;
        const progressBar = '█'.repeat(filled) + '░'.repeat(empty);
        const percentage = (progress * 100).toFixed(2);
        
        // 格式化时间 hh:mm:ss
        const formatTime = (seconds) => {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        };

        process.stdout.write(`\r[${path.basename(inputPath)}] [${progressBar}] ${percentage}% (${formatTime(time)} / ${formatTime(total)})`);
    };

    return new Promise(async (resolve) => {
        if (fs.existsSync(outputPath)) {
            writeLog(`跳过: 目标文件已存在。${outputPath}`, 'WARNING');
            return resolve();
        }

        // --- 1. 获取原文件时间戳 ---
        let originalMtime, originalAtime;
        try {
            const stats = fs.statSync(inputPath);
            originalMtime = stats.mtime;
            originalAtime = stats.atime;
        } catch (e) {
            writeLog(`警告: 无法读取原文件时间戳。错误: ${e.message}`, 'WARNING');
        }

        // 2. 获取视频总时长，用于进度计算
        totalDurationSeconds = await getDuration(inputPath);
        if (totalDurationSeconds === 0) {
            writeLog(`警告: 无法获取视频时长，进度条将不显示。文件: ${inputPath}`, 'WARNING');
        }

        writeLog(`\n开始转换: ${inputPath} -> ${outputPath}`);
        
        // 3. 构造 FFmpeg 命令参数
        const args = [
            '-loglevel', 'info',  // info, warning, error, quiet
            '-i', inputPath,
            '-c', 'copy',
            '-y', // 自动覆盖输出文件
            outputPath
        ];

        // 4. 启动 FFmpeg 进程
        const ffmpeg = spawn(FFMPEG_CMD, args);

        // 5. 处理 FFmpeg 进程退出
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                // 成功退出
                process.stdout.write('\n'); // 换行以清除进度条
                
                // --- 6. 成功后复制时间戳 ---
                if (originalMtime && originalAtime) {
                    try {
                        // 使用 fs.utimesSync 将原文件的访问时间和修改时间应用到新文件
                        fs.utimesSync(outputPath, originalAtime, originalMtime);
                        writeLog(`时间戳已复制到新文件: ${outputPath}`, 'INFO');
                    } catch (utimesError) {
                        writeLog(`警告: 复制时间戳失败。错误: ${utimesError.message}`, 'WARNING');
                    }
                }

                writeLog(`成功转换: ${inputPath}`, 'INFO');
                // 转换成功后，可取消注释以下行来删除原文件（请谨慎操作！）
                // fs.unlinkSync(inputPath); 
            } else {
                // 失败退出 (保持不变)
                process.stdout.write('\n'); 
                writeLog(`转换失败: ${inputPath}。错误代码: ${code}`, 'ERROR');
                console.error(`【错误】转换失败，已记录。文件: ${path.basename(inputPath)}`);
            }
            resolve();
        });

        // 7. 处理进程错误 (例如找不到 ffmpeg.exe)
        ffmpeg.on('error', (err) => {
            process.stdout.write('\n');
            if (err.code === 'ENOENT') {
                 writeLog(`【致命错误】找不到 FFmpeg 命令。请确保 FFmpeg 已安装并设置了系统路径，或修改脚本中的 FFMPEG_CMD 变量。`, 'CRITICAL');
            } else {
                writeLog(`进程错误: ${inputPath}。错误: ${err.message}`, 'ERROR');
            }
            resolve();
        });
    });
}


async function main() {
    console.log("--- 视频批量流复制转换工具 (Node.js + FFmpeg) ---");
    console.log(`目标目录: ${TARGET_DIR}`);
    console.log(`日志文件: ${LOG_FILE}`);
    console.log("-----------------------------------------");
    
    // 初始化日志文件
    fs.writeFileSync(LOG_FILE, `--- 视频批量流复制转换日志 ---\n`, 'utf8');

    if (!fs.existsSync(TARGET_DIR)) {
        writeLog(`【致命错误】目标目录不存在: ${TARGET_DIR}。请创建该目录或修改 TARGET_DIR 变量。`, 'CRITICAL');
        return;
    }

    const filesToConvert = collectFiles(TARGET_DIR);
    console.log(`共找到 ${filesToConvert.length} 个待处理文件。`);

    for (const file of filesToConvert) {
        // 顺序执行，等待每个文件转换完成
        await convertVideoStreamCopy(file);
    }
    
    console.log("-----------------------------------------");
    writeLog(`转换任务完成。共尝试处理 ${filesToConvert.length} 个文件。`);
    console.log(`详情请查看 ${LOG_FILE}。`);
}

// 确保在主线程运行，并在底部正确定义 execPromise
if (require.main === module) {
    main().catch(err => {
        writeLog(`程序运行中断: ${err.message}`, 'CRITICAL');
        console.error(`程序运行中断: ${err.message}`);
    });
}