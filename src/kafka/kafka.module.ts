// src/kafka/kafka.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { KafkaService } from './kafka.service';
import { KafkaController } from './controllers/kafka.controller';
import { MessageConsumer } from './consumers/message.consumer';
import { AutopilotProducer } from './producers/autopilot.producer';
import { AutopilotConsumer } from './consumers/autopilot.consumer';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { AutopilotModule } from '../autopilot/autopilot.module';

@Module({
  imports: [ConfigModule, AuthModule, forwardRef(() => AutopilotModule)],
  controllers: [KafkaController],
  providers: [
    KafkaService,
    AutopilotProducer,
    AutopilotConsumer,
    MessageConsumer,
  ],
  exports: [KafkaService, AutopilotProducer],
})
export class KafkaModule {}
