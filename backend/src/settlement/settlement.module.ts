import { Module } from '@nestjs/common';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { RefundsController } from './refunds.controller';

@Module({
  controllers: [SettlementController, RefundsController],
  providers: [SettlementService],
})
export class SettlementModule {}
