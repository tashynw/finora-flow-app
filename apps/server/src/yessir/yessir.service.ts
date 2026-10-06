import { Injectable } from '@nestjs/common';

@Injectable()
export class YessirService {
  hello(): string {
    return 'yoo';
  }
}
