import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import config from './config.mjs';
import { LOGGING } from './constants.mjs';

export function createLogger({ dirname, filename }) {
    const logDir = path.resolve(process.cwd(), dirname);

    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    const dailyRotateFileTransport = new winston.transports.DailyRotateFile({
        filename: path.join(logDir, filename),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: config.LOG_ROTATION_MAX_SIZE,
        maxFiles: config.LOG_ROTATION_MAX_FILES,
    });

    const logger = winston.createLogger({
        level: config.LOG_LEVEL,
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss',
            }),
            winston.format.printf((info) => {
                let log = `${info.timestamp} ${info.level}: ${info.message}`;
                if (info.stack) {
                    log = `${log}
${info.stack}`;
                }
                return log;
            })
        ),
        transports: [
            new winston.transports.Console({
                level: config.LOG_LEVEL,
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(
                        (info) =>
                            `${info.timestamp} ${info.level}: ${info.message}`
                    )
                ),
            }),
            dailyRotateFileTransport,
        ],
    });

    return logger;
}