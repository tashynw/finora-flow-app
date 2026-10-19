import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { SavedViewsService } from './saved-views.service.js';

@Controller('saved-views')
@UseGuards(AuthGuard)
export class SavedViewsController {
  constructor(private readonly savedViews: SavedViewsService) {}

  @Get()
  list(@Session() session: UserSession, @Query('scope') scope = '') {
    return this.savedViews.list(session, scope);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Session() session: UserSession,
    @Body()
    body: {
      scope: string;
      name: string;
      definition: Record<string, unknown>;
      is_default?: boolean;
    },
  ) {
    return this.savedViews.create(session, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Session() session: UserSession, @Param('id') id: string) {
    return this.savedViews.remove(session, id);
  }
}
