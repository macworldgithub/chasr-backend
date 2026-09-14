import {
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ContactAddressDto {
  @ApiPropertyOptional({ example: '1 George Street' })
  @IsOptional()
  @IsString()
  street?: string;
  @ApiPropertyOptional({ example: 'Sydney' })
  @IsOptional()
  @IsString()
  city?: string;
  @ApiPropertyOptional({ example: 'NSW' })
  @IsOptional()
  @IsString()
  state?: string;
  @ApiPropertyOptional({ example: '2000' })
  @IsOptional()
  @IsString()
  postcode?: string;
  @ApiPropertyOptional({ example: 'Australia' })
  @IsOptional()
  @IsString()
  country?: string;
}

export class CreateContactDto {
  @ApiProperty({ example: 'Acme Pty Ltd' })
  @IsString()
  name: string;
  @ApiPropertyOptional({ type: [String], example: ['billing@acme.com'] })
  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true })
  emails?: string[];
  @ApiPropertyOptional({ type: [String], example: ['+61 400 000 000'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phones?: string[];
  @ApiPropertyOptional({ type: ContactAddressDto })
  @IsOptional()
  address?: ContactAddressDto;
  @ApiPropertyOptional({ example: 30, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  paymentTermsDays?: number;
}

export class UpdateContactDto {
  @ApiPropertyOptional({ example: 'Acme Pty Ltd' })
  @IsOptional()
  @IsString()
  name?: string;
  @ApiPropertyOptional({ type: [String], example: ['billing@acme.com'] })
  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true })
  emails?: string[];
  @ApiPropertyOptional({ type: [String], example: ['+61 400 000 000'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phones?: string[];
  @ApiPropertyOptional({ type: ContactAddressDto })
  @IsOptional()
  address?: ContactAddressDto;
  @ApiPropertyOptional({ example: 30, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  paymentTermsDays?: number;
}

export class ContactQueryDto {
  @ApiPropertyOptional({
    example: 'acme',
    description: 'Case-insensitive name search',
  })
  @IsOptional()
  @IsString()
  search?: string;
  @ApiPropertyOptional({ example: 'xero' })
  @IsOptional()
  @IsString()
  externalSource?: string;
  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsString()
  chaseState?: string;
  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @IsString()
  page?: string;
  @ApiPropertyOptional({ example: 25, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsString()
  limit?: string;
}

export class CreateInvoiceDto {
  @ApiProperty({ example: 'INV-1001' })
  @IsString()
  invoiceNumber: string;
  @ApiPropertyOptional({ enum: ['ACCREC', 'ACCPAY'], default: 'ACCREC' })
  @IsOptional()
  @IsEnum(['ACCREC', 'ACCPAY'])
  invoiceType?: 'ACCREC' | 'ACCPAY';
  @ApiPropertyOptional({ example: 'CN-001' })
  @IsOptional()
  @IsString()
  creditNoteNumber?: string;
  @ApiPropertyOptional({ type: [String], example: ['INV-0999'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  linkedInvoiceIds?: string[];
  @ApiPropertyOptional({ example: '2026-09-01', format: 'date' })
  @IsOptional()
  @IsDateString()
  issueDate?: string;
  @ApiProperty({ example: '2026-09-30', format: 'date' })
  @IsDateString()
  dueDate: string;
  @ApiProperty({ example: 1250.5, minimum: 0 })
  @IsNumber()
  total: number;
  @ApiProperty({ example: 1250.5, minimum: 0 })
  @IsNumber()
  balanceDue: number;
  @ApiPropertyOptional({ example: 'AUD', default: 'AUD' })
  @IsOptional()
  @IsString()
  currency?: string;
  @ApiPropertyOptional({
    enum: ['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'],
    default: 'AUTHORISED',
  })
  @IsOptional()
  @IsEnum(['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'])
  status?: string;
  @ApiPropertyOptional({ example: 'https://example.com/invoices/INV-1001.pdf' })
  @IsOptional()
  @IsString()
  pdfUrl?: string;
  @ApiPropertyOptional({
    description: 'Internal Contact ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @IsOptional()
  @IsString()
  contactId?: string;
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional({ example: 'INV-1001' })
  @IsOptional()
  @IsString()
  invoiceNumber?: string;
  @ApiPropertyOptional({ enum: ['ACCREC', 'ACCPAY'] })
  @IsOptional()
  @IsEnum(['ACCREC', 'ACCPAY'])
  invoiceType?: 'ACCREC' | 'ACCPAY';
  @ApiPropertyOptional({ example: 'CN-001' })
  @IsOptional()
  @IsString()
  creditNoteNumber?: string;
  @ApiPropertyOptional({ type: [String], example: ['INV-0999'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  linkedInvoiceIds?: string[];
  @ApiPropertyOptional({ example: '2026-09-01', format: 'date' })
  @IsOptional()
  @IsDateString()
  issueDate?: string;
  @ApiPropertyOptional({ example: '2026-09-30', format: 'date' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
  @ApiPropertyOptional({ example: 1250.5, minimum: 0 })
  @IsOptional()
  @IsNumber()
  total?: number;
  @ApiPropertyOptional({ example: 1250.5, minimum: 0 })
  @IsOptional()
  @IsNumber()
  balanceDue?: number;
  @ApiPropertyOptional({ example: 'AUD' })
  @IsOptional()
  @IsString()
  currency?: string;
  @ApiPropertyOptional({
    enum: ['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'],
  })
  @IsOptional()
  @IsEnum(['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'])
  status?: string;
  @ApiPropertyOptional({ example: 'https://example.com/invoices/INV-1001.pdf' })
  @IsOptional()
  @IsString()
  pdfUrl?: string;
  @ApiPropertyOptional({
    description: 'Internal Contact ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @IsOptional()
  @IsString()
  contactId?: string;
}

export class InvoiceQueryDto {
  @ApiPropertyOptional({
    example: 'INV-1001',
    description: 'Search invoice or credit note number',
  })
  @IsOptional()
  @IsString()
  search?: string;
  @ApiPropertyOptional({
    enum: ['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'],
  })
  @IsOptional()
  @IsEnum(['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'])
  status?: string;
  @ApiPropertyOptional({
    enum: ['pending', 'active', 'paused', 'complete', 'excluded'],
  })
  @IsOptional()
  @IsString()
  chaseState?: string;
  @ApiPropertyOptional({ example: '507f1f77bcf86cd799439011' })
  @IsOptional()
  @IsString()
  contactId?: string;
  @ApiPropertyOptional({ example: 'xero' })
  @IsOptional()
  @IsString()
  externalSource?: string;
  @ApiPropertyOptional({ example: '2026-09-01', format: 'date-time' })
  @IsOptional()
  @IsDateString()
  dueDateFrom?: string;
  @ApiPropertyOptional({ example: '2026-09-30', format: 'date-time' })
  @IsOptional()
  @IsDateString()
  dueDateTo?: string;
  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @IsString()
  page?: string;
  @ApiPropertyOptional({ example: 25, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsString()
  limit?: string;
}
