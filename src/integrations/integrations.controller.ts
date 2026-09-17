import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';
import { XeroOAuthService } from '../connectors/xero/xero-oauth.service';
import { MyobOAuthService } from '../connectors/myob/myob-oauth.service';
import { QuickBooksOAuthService } from '../connectors/quickbooks/quickbooks-oauth.service';
import { CsvConnector } from '../connectors/csv/csv.connector';
import { SyncOrchestratorService } from '../sync/sync-orchestrator.service';
import { OrgScopeGuard } from '../shared/guards/org-scope.guard';
import { Public } from '../shared/decorators/public.decorator';
import {
  CsvCommitDto,
  CreateCredentialConnectionDto,
} from './dto/integration.dtos';
import {
  ContactQueryDto,
  CreateContactDto,
  UpdateContactDto,
  InvoiceQueryDto,
  CreateInvoiceDto,
  UpdateInvoiceDto,
} from './dto/record.dtos';
import type { Provider } from './schemas/accounting-connection.schema';

@Controller('integrations')
@ApiTags('Integrations')
@ApiBearerAuth()
@UseGuards(OrgScopeGuard)
export class IntegrationsController {
  private readonly frontendUrl: string = 'https://chasr-frontend.vercel.app';

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly xeroOAuth: XeroOAuthService,
    private readonly myobOAuth: MyobOAuthService,
    private readonly quickBooksOAuth: QuickBooksOAuthService,
    private readonly csvConnector: CsvConnector,
    private readonly orchestrator: SyncOrchestratorService,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'https://chasr-frontend.vercel.app';
  }

  // ── Contacts ────────────────────────────────────────────────────────────────

  @Get('contacts')
  @ApiOperation({ summary: 'List contacts with filtering and pagination' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Case-insensitive contact name search',
    example: 'acme',
  })
  @ApiQuery({
    name: 'externalSource',
    required: false,
    enum: ['xero', 'myob', 'csv'],
  })
  @ApiQuery({ name: 'chaseState', required: false, example: 'active' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { minimum: 1, default: 1 },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 25,
    schema: { minimum: 1, maximum: 100, default: 25 },
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated contacts: data and pagination metadata',
  })
  async listContacts(@Req() req: any, @Query() query: ContactQueryDto) {
    return this.integrationsService.listContacts(req.orgId, query);
  }

  @Get('contacts/:id')
  @ApiOperation({ summary: 'Get one contact' })
  @ApiParam({
    name: 'id',
    description: 'Contact ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({ status: 200, description: 'Contact details' })
  async getContact(@Req() req: any, @Param('id') id: string) {
    return this.integrationsService.getContact(req.orgId, id);
  }

  @Post('contacts')
  @ApiOperation({ summary: 'Create a contact' })
  @ApiBody({ type: CreateContactDto })
  @ApiResponse({ status: 201, description: 'Contact created' })
  async createContact(@Req() req: any, @Body() body: CreateContactDto) {
    return this.integrationsService.createContact(req.orgId, body);
  }

  @Patch('contacts/:id')
  @ApiOperation({ summary: 'Update a contact' })
  @ApiParam({
    name: 'id',
    description: 'Contact ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiBody({ type: UpdateContactDto })
  @ApiResponse({ status: 200, description: 'Contact updated' })
  async updateContact(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: UpdateContactDto,
  ) {
    return this.integrationsService.updateContact(req.orgId, id, body);
  }

  // ── Invoices ────────────────────────────────────────────────────────────────

  @Get('invoices')
  @ApiOperation({ summary: 'List invoices with filtering and pagination' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Case-insensitive invoice or credit note number search',
    example: 'INV-1001',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'],
  })
  @ApiQuery({
    name: 'chaseState',
    required: false,
    enum: ['pending', 'active', 'paused', 'complete', 'excluded'],
  })
  @ApiQuery({
    name: 'contactId',
    required: false,
    description: 'Filter by internal Contact ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiQuery({
    name: 'externalSource',
    required: false,
    enum: ['xero', 'myob', 'csv'],
  })
  @ApiQuery({
    name: 'dueDateFrom',
    required: false,
    type: String,
    example: '2026-09-01T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'dueDateTo',
    required: false,
    type: String,
    example: '2026-09-30T23:59:59.999Z',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { minimum: 1, default: 1 },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 25,
    schema: { minimum: 1, maximum: 100, default: 25 },
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated invoices: data and pagination metadata',
  })
  async listInvoices(@Req() req: any, @Query() query: InvoiceQueryDto) {
    return this.integrationsService.listInvoices(req.orgId, query);
  }

  @Get('invoices/:id')
  @ApiOperation({ summary: 'Get one invoice' })
  @ApiParam({
    name: 'id',
    description: 'Invoice ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({ status: 200, description: 'Invoice details' })
  async getInvoice(@Req() req: any, @Param('id') id: string) {
    return this.integrationsService.getInvoice(req.orgId, id);
  }

  @Post('invoices')
  @ApiOperation({ summary: 'Create an invoice' })
  @ApiBody({ type: CreateInvoiceDto })
  @ApiResponse({ status: 201, description: 'Invoice created' })
  async createInvoice(@Req() req: any, @Body() body: CreateInvoiceDto) {
    return this.integrationsService.createInvoice(req.orgId, body);
  }

  @Patch('invoices/:id')
  @ApiOperation({ summary: 'Update an invoice' })
  @ApiParam({
    name: 'id',
    description: 'Invoice ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiBody({ type: UpdateInvoiceDto })
  @ApiResponse({ status: 200, description: 'Invoice updated' })
  async updateInvoice(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: UpdateInvoiceDto,
  ) {
    return this.integrationsService.updateInvoice(req.orgId, id, body);
  }

  // ── Connection Management ───────────────────────────────────────────────────

  @Get('connections')
  @ApiOperation({ summary: 'List accounting connections for the current org' })
  @ApiResponse({
    status: 200,
    description: 'List of active accounting connections',
  })
  async getConnections(@Req() req: any) {
    return this.integrationsService.getConnections(req.orgId);
  }

  @Get('connections/:id')
  @ApiOperation({
    summary: 'Fetch a single accounting connection and recent sync logs',
  })
  @ApiParam({ name: 'id', description: 'Connection ID' })
  async getConnection(@Req() req: any, @Param('id') connectionId: string) {
    return this.integrationsService.getConnection(req.orgId, connectionId);
  }

  @Delete('connections/:id')
  async deleteConnection(@Req() req: any, @Param('id') connectionId: string) {
    await this.integrationsService.deleteConnection(
      req.orgId,
      connectionId,
      req.user.id,
    );
    return { success: true };
  }

  @Post('connections')
  async createCredentialConnection(
    @Req() req: any,
    @Body() body: CreateCredentialConnectionDto,
  ) {
    return this.integrationsService.createCredentialConnection(
      req.orgId,
      body.provider,
      body.authMethod,
      body.credentials,
      req.user.id,
    );
  }

  // ── OAuth Flows ─────────────────────────────────────────────────────────────

  @Post('connections/xero/auth-url')
  @ApiOperation({ summary: 'Generate the Xero OAuth authorization URL' })
  @ApiResponse({
    status: 201,
    description: 'Authorization URL generated successfully',
  })
  async getXeroAuthUrl(@Req() req: any) {
    return this.xeroOAuth.generateAuthUrl(req.orgId, req.user.id);
  }

  @Public()
  @Get('connections/xero/callback')
  @ApiOperation({ summary: 'Handle Xero OAuth callback redirection' })
  async handleXeroCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    try {
      if (!code || !state) {
        return res.redirect(
          `${this.frontendUrl}/oauth/callback?status=error&message=${encodeURIComponent('Xero authorization failed or was cancelled.')}`,
        );
      }

      const { connection, tenants, orgId, userId } =
        await this.xeroOAuth.exchangeCode(code, state);

      if (tenants.length > 1) {
        return res.redirect(`${this.frontendUrl}/`);
      }

      await this.orchestrator.dispatchFullSync(
        connection._id.toString(),
        orgId,
        userId,
      );

      return res.redirect(`${this.frontendUrl}/`);
    } catch (error) {
      return res.redirect(
        `${this.frontendUrl}/oauth/callback?status=error&message=${encodeURIComponent('Xero authorization failed or was cancelled.')}`,
      );
    }
  }

  @Get('connections/xero/:id/tenants')
  @ApiOperation({ summary: 'List available Xero tenants for a connection' })
  async getXeroTenants(@Param('id') connectionId: string) {
    return this.xeroOAuth.getTenants(connectionId);
  }

  @Post('connections/xero/:id/select-tenant')
  @ApiOperation({ summary: 'Switch active Xero tenant and trigger sync' })
  async selectXeroTenant(
    @Req() req: any,
    @Param('id') connectionId: string,
    @Body('tenantId') tenantId: string,
  ) {
    if (!tenantId) throw new BadRequestException('tenantId is required');
    await this.xeroOAuth.selectTenant(connectionId, tenantId);

    // Now trigger sync
    await this.orchestrator.dispatchFullSync(
      connectionId,
      req.orgId,
      req.user.id,
    );
    return { success: true };
  }

  @Get('connections/:id/organisation')
  @ApiOperation({ summary: 'Get synced organisation info for a connection' })
  async getOrganisationInfo(
    @Req() req: any,
    @Param('id') connectionId: string,
  ) {
    return this.integrationsService.getOrganisation(req.orgId, connectionId);
  }

  @Post('connections/myob/auth-url')
  @ApiOperation({ summary: 'Generate the MYOB OAuth authorization URL' })
  async getMyobAuthUrl(@Req() req: any) {
    return this.myobOAuth.generateAuthUrl(req.orgId, req.user.id);
  }

  @Public()
  @Get('connections/myob/callback')
  async handleMyobCallback(
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    return this.myobOAuth.exchangeCode(code, state);
  }

  @Post('connections/quickbooks/auth-url')
  async getQuickBooksAuthUrl(@Req() req: any) {
    return this.quickBooksOAuth.generateAuthUrl(req.orgId, req.user.id);
  }

  @Public()
  @Get('connections/quickbooks/callback')
  async handleQuickBooksCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('realmId') realmId: string,
    @Res() res: Response,
  ) {
    try {
      if (!code || !state) {
        return res.redirect(
          `${this.frontendUrl}/oauth/callback?status=error&message=${encodeURIComponent(
            'QuickBooks authorization failed or was cancelled.',
          )}`,
        );
      }

      const connection = await this.quickBooksOAuth.exchangeCode(
        code,
        state,
        realmId,
      );

      await this.orchestrator.dispatchFullSync(
        connection._id.toString(),
        connection.orgId.toString(),
        'system:oauth',
      );

      return res.redirect(`${this.frontendUrl}/`);
    } catch {
      return res.redirect(
        `${this.frontendUrl}/oauth/callback?status=error&message=${encodeURIComponent(
          'QuickBooks authorization failed or was cancelled.',
        )}`,
      );
    }
  }

  // ── Sync Operations ─────────────────────────────────────────────────────────

  @Post('connections/:id/sync')
  async triggerSync(@Req() req: any, @Param('id') connectionId: string) {
    return this.integrationsService.triggerManualSync(
      req.orgId,
      connectionId,
      req.user.id,
    );
  }

  @Get('connections/:id/sync-status/:jobId')
  async getSyncStatus(@Param('jobId') jobId: string) {
    return this.integrationsService.getSyncStatus(jobId);
  }

  @Get('connections/:id/sync-logs')
  async getSyncLogs(
    @Req() req: any,
    @Param('id') connectionId: string,
    @Query('page') page: string,
    @Query('limit') limit: string,
  ) {
    return this.integrationsService.getSyncLogs(
      req.orgId,
      connectionId,
      Number(page) || 1,
      Number(limit) || 50,
    );
  }

  @Get('sync-logs/:id')
  async getSyncLogDetail(@Req() req: any, @Param('id') syncLogId: string) {
    return this.integrationsService.getSyncLogDetail(req.orgId, syncLogId);
  }

  // ── CSV Upload ──────────────────────────────────────────────────────────────

  @Post('csv/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      dest: process.env.CSV_TEMP_STORAGE_PATH || './tmp/chasr-csv',
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async uploadCsv(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('provider') provider?: Provider,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.csvConnector.stageUpload(
      req.orgId,
      file.path,
      file.originalname,
      provider,
    );
  }

  @Post('csv/mappings')
  @ApiOperation({
    summary:
      'Validate a CSV mapping configuration against the uploaded dataset',
  })
  @ApiBody({ type: CsvCommitDto })
  async validateMappings(@Body() body: CsvCommitDto) {
    return this.csvConnector.validateMappings(body.uploadId, body.mappings);
  }

  @Post('csv/commit')
  async commitCsvUpload(@Req() req: any, @Body() body: CsvCommitDto) {
    // Validate first (to get row counts etc. for audit/log metadata if desired)
    const validation = await this.csvConnector.validateMappings(
      body.uploadId,
      body.mappings,
    );
    if (validation.errors.length > 0 && validation.validRows === 0) {
      throw new BadRequestException('Cannot commit file with zero valid rows');
    }

    const csvMeta = {
      templateName: body.templateName,
      totalRows: validation.totalRows,
      validRows: validation.validRows,
    };

    return this.orchestrator.dispatchCsvIngest(
      body.uploadId,
      body.mappings,
      req.orgId,
      req.user.id,
      csvMeta,
    );
  }

  @Get('csv/templates')
  async getCsvTemplates() {
    return [
      {
        name: 'Xero AR Export',
        provider: 'xero',
        downloadUrl: '/templates/xero-ar-export-template.csv',
      },
      {
        name: 'MYOB AccountRight',
        provider: 'myob',
        downloadUrl: '/templates/myob-accountright-template.csv',
      },
      {
        name: 'QuickBooks',
        provider: 'quickbooks',
        downloadUrl: '/templates/quickbooks-invoice-template.csv',
      },
      {
        name: 'Generic AR',
        provider: 'generic',
        downloadUrl: '/templates/generic-ar-template.csv',
      },
    ];
  }
}
