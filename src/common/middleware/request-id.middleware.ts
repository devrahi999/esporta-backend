import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { contextOf } from '../http/request-context';

/**
 * Assigns a request id (honouring an inbound `x-request-id`) and echoes it back
 * in the response header. Everything downstream — logs, the response envelope's
 * `meta.requestId`, error bodies — keys off this so a single request can be
 * traced end to end (plan §33).
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers['x-request-id'];
    const requestId =
      (typeof inbound === 'string' && inbound.trim().length > 0 && inbound.trim().slice(0, 128)) ||
      randomUUID();

    const ctx = contextOf(req);
    ctx.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  }
}
