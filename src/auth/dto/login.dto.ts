import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'admin@chasr.local',
    description: 'Username or email for login.',
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    example: 'ChangeThisPassword123!',
    description: 'Password for the account.',
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}
