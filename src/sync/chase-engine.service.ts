// src/sync/chase-engine.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';

/**
 * ChaseEngineService — stub for Phase 1.
 *
 * Emits events on the NestJS EventEmitter bus. The real chase engine
 * should subscribe to these events in a separate module:
 *
 *   @OnEvent('chase.halt')
 *   handleChaseHalt(payload: { invoiceId, reason }) { ... }
 *
 *   @OnEvent('chase.enroll')
 *   handleChaseEnroll(payload: { invoiceId, orgId }) { ... }
 *
 * This decoupling means the sync pipeline has zero dependency on
 * chase engine internals. Adding the real chase engine in Phase 2
 * requires ZERO changes here.
 */
@Injectable()
export class ChaseEngineService {
  private readonly logger = new Logger(ChaseEngineService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * Signal that a chase sequence for an invoice should halt.
   * Called when: status = PAID, balanceDue = 0, or status = VOIDED.
   *
   * @param invoiceId  Chasr internal invoice ID
   * @param reason     'payment_received' | 'invoice_voided'
   */
  async haltChase(
    invoiceId: Types.ObjectId,
    reason: 'payment_received' | 'invoice_voided',
  ): Promise<void> {
    this.logger.log(
      `Chase halt signalled: invoice=${invoiceId}, reason=${reason}`,
    );

    this.eventEmitter.emit('chase.halt', { invoiceId, reason });
  }

  /**
   * Signal that an overdue invoice should be enrolled in a chase sequence.
   * Called when: invoice is overdue and chaseState = 'pending'.
   *
   * @param invoiceId  Chasr internal invoice ID
   * @param orgId      Organisation ID (for sequence selection)
   */
  async enrollInChaseSequence(
    invoiceId: Types.ObjectId,
    orgId: Types.ObjectId,
  ): Promise<void> {
    this.logger.log(
      `Chase enroll signalled: invoice=${invoiceId}, org=${orgId}`,
    );

    this.eventEmitter.emit('chase.enroll', { invoiceId, orgId });
  }
}
