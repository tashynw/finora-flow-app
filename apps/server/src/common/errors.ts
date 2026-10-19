import { HttpException, HttpStatus } from '@nestjs/common';

export class DomainException extends HttpException {
  constructor(
    message: string,
    status?: HttpStatus,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super({ message, code, details }, status ?? HttpStatus.BAD_REQUEST);
  }
}

export function notFound(entity: string, id?: string) {
  return new DomainException(
    id ? `${entity} ${id} not found` : `${entity} not found`,
    HttpStatus.NOT_FOUND,
    'NOT_FOUND',
  );
}

export function forbidden(message = 'Forbidden') {
  return new DomainException(message, HttpStatus.FORBIDDEN, 'FORBIDDEN');
}

export function conflict(message: string) {
  return new DomainException(message, HttpStatus.CONFLICT, 'CONFLICT');
}
