import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Chasr Accounting Integrations API')
    .setDescription(
      'API for connecting accounting providers, syncing invoices/contacts/payments, and managing CSV ingestion.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Chasr API Docs',
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
