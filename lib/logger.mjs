import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

export function createLogger({ dirname, filename }) {
    const logDir = path.resolve(process.cwd(), dirname);

    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    const dailyRotateFileTransport = new winston.transports.DailyRotateFile({
        filename: path.join(logDir, filename),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '100m',
        maxFiles: '14d',
    });

    const logger = winston.createLogger({
        level: 'debug',
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss',
            }),
        winston.format.printf(info => {
            let log = `${info.timestamp} ${info.level}: ${info.message}`;
            if (info.stack) {
                log = `${log}\n${info.stack}`;
            }
            return log;
        })
        ),
        transports: [
            new winston.transports.Console({
                level: 'debug',
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(
                        (info) => `${info.timestamp} ${info.level}: ${info.message}`
                    )
                ),
            }),
            dailyRotateFileTransport,
        ],
    });

    return logger;
}
