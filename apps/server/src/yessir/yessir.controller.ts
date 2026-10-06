import { Controller, Get } from '@nestjs/common';
import { YessirService } from './yessir.service.js';

@Controller('yessir')
export class YessirController {
  constructor(private readonly yessirService: YessirService) {}

  @Get('hello')
  hello(): string {
    return this.yessirService.hello();
  }
}
