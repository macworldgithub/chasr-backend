// src/integrations/dto/integration.dtos.ts
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ValidateNested,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  Provider,
  AuthMethod,
} from '../schemas/accounting-connection.schema';

export class CsvMappingDto {
  @ApiProperty({
    example: 'customerName',
    description: 'Column name in the uploaded CSV file.',
  })
  @IsString()
  @IsNotEmpty()
  sourceColumn: string;

  @ApiProperty({
    example: 'contactName',
    description: 'Target field in the Chasr schema.',
  })
  @IsString()
  @IsNotEmpty()
  targetField: string;
}

export class CsvCommitDto {
  @ApiProperty({
    example: 'csv-upload-123',
    description: 'Upload ID produced by the CSV staging step.',
  })
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @ApiProperty({
    type: [CsvMappingDto],
    description: 'Mapping between CSV columns and target fields.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CsvMappingDto)
  mappings: CsvMappingDto[];

  @ApiPropertyOptional({
    example: 'Xero AR Export',
    description: 'Optional template name for the CSV import.',
  })
  @IsOptional()
  @IsString()
  templateName?: string;
}

export class CreateCredentialConnectionDto {
  @ApiProperty({ enum: ['xero', 'myob', 'quickbooks'], example: 'xero' })
  @IsEnum(['xero', 'myob', 'quickbooks'])
  provider: Provider;

  @ApiProperty({ enum: ['oauth2', 'api_key', 'credential'], example: 'oauth2' })
  @IsEnum(['oauth2', 'api_key', 'credential'])
  authMethod: AuthMethod;

  @ApiProperty({
    example: { accessToken: 'token', tenantId: 'tenant-123' },
    description:
      'Provider credentials as key/value pairs. Sensitive values are encrypted before storage.',
  })
  @IsNotEmpty()
  credentials: Record<string, string>;
}
