import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AuthGuard,
  Roles,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { parseBoolQuery } from '../common/query.js';
import { AdminUsersService } from './admin-users.service.js';

@Controller('admin/users')
@UseGuards(AuthGuard)
@Roles(['administrator'])
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  list(@Query('include_inactive') includeInactive?: string) {
    return this.adminUsersService.list(parseBoolQuery(includeInactive, true));
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.adminUsersService.getById(id);
  }

  @Post()
  create(
    @Body()
    body: {
      email: string;
      display_name: string;
      department: string | null;
      roles: string[];
      reason: string;
    },
    @Session() session: UserSession,
  ) {
    return this.adminUsersService.create(body, session);
  }

  @Put(':id/roles')
  setRoles(
    @Param('id') id: string,
    @Body() body: { roles: string[]; reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminUsersService.setRoles(id, body, session);
  }

  @Post(':id/active')
  setActive(
    @Param('id') id: string,
    @Body() body: { is_active: boolean; reason: string },
    @Session() session: UserSession,
  ) {
    return this.adminUsersService.setActive(id, body, session);
  }
}
