import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { serialize } from '../common/serialize.js';
import { SearchService } from './search.service.js';

@Controller('search')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get()
  async search(@Query('q') q: string, @Query('limit') limit?: string) {
    const take = limit ? Number(limit) : 25;
    return serialize(await this.service.search(q ?? '', take));
  }
}
