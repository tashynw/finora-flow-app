import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { YessirService } from './yessir.service.js';

@Controller('yessir')
export class YessirController {
  constructor(private readonly yessirService: YessirService) {}

  @Get('public')
  publicHello(): string {
    return 'hello world';
  }

  @Get('hello')
  @UseGuards(AuthGuard)
  @Roles(['administrator'])
  hello(@Session() session: UserSession) {
    return {
      message: this.yessirService.hello(),
      user: {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      },
    };
  }
}
