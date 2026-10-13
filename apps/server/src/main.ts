import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Better Auth reads the raw body. Nest must not parse it first.
    bodyParser: false,
  });
  const parseJson = json();
  const parseUrlencoded = urlencoded({ extended: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/auth')) return next();
    parseJson(req, res, (error) => {
      if (error) return next(error);
      parseUrlencoded(req, res, next);
    });
  });
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
