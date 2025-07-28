import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiResponse, ApiTags, ApiOperation } from '@nestjs/swagger';
import { LoginDto } from './dto/login.dto';

interface LoginResponse {
  access_token: string;
}

interface User {
  id: number;
  username: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Authenticate user and return JWT token.' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Authentication successful.',
    type: LoginDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid credentials.',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Internal server error.',
  })
  async login(@Body() loginDto: LoginDto): Promise<LoginResponse> {
    const user = (await this.authService.validateUser(
      loginDto.username,
      loginDto.password,
    )) as User | null;

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.authService.login(user);
  }
}
