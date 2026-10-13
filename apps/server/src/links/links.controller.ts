import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { LinksService } from './links.service.js';

@Controller('links')
@UseGuards(AuthGuard)
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Post('resolve')
  resolve(@Session() session: UserSession, @Body() body: { token: string }) {
    return this.links.resolve(body.token, session.user.id);
  }
}
