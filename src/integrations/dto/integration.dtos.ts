// src/integrations/dto/integration.dtos.ts
import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import type { Provider, AuthMethod } from '../schemas/accounting-connection.schema';

export class CsvMappingDto {
  @IsString()
  @IsNotEmpty()
  sourceColumn: string;

  @IsString()
  @IsNotEmpty()
  targetField: string;
}

export class CsvCommitDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CsvMappingDto)
  mappings: CsvMappingDto[];

  @IsOptional()
  @IsString()
  templateName?: string;
}

export class CreateCredentialConnectionDto {
  @IsEnum(['xero', 'myob', 'quickbooks'])
  provider: Provider;

  @IsEnum(['api_key', 'credential'])
  authMethod: AuthMethod;

  @IsNotEmpty()
  credentials: Record<string, string>;
}
