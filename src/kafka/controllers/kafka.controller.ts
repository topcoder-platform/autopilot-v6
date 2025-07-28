import { Controller, Post, Body, HttpStatus } from '@nestjs/common';
import { AutopilotProducer } from '../producers/autopilot.producer';
import {
  PhaseTransitionMessageDto,
  ChallengeUpdateMessageDto,
  CommandMessageDto,
} from '../dto/produce-message.dto';

import { ApiResponse, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('kafka')
@Controller('kafka')
export class KafkaController {
  constructor(private readonly autopilotProducer: AutopilotProducer) {}

  @Post('phase-transition')
  @ApiOperation({ summary: 'Produce a phase transition message to Kafka.' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Message produced successfully.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid message payload.',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Internal server error or Kafka producer failure.',
  })
  async producePhaseTransition(@Body() message: PhaseTransitionMessageDto) {
    await this.autopilotProducer.sendPhaseTransition(message.payload);
    return {
      success: true,
      message: 'Phase transition message produced successfully',
      data: {
        timestamp: message.timestamp,
        projectId: message.payload.projectId,
        phaseId: message.payload.phaseId,
        state: message.payload.state,
      },
    };
  }

  @Post('challenge-update')
  @ApiOperation({ summary: 'Produce a challenge update message to Kafka.' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Message produced successfully.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid message payload.',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Internal server error or Kafka producer failure.',
  })
  async produceChallengeUpdate(@Body() message: ChallengeUpdateMessageDto) {
    await this.autopilotProducer.sendChallengeUpdate(message.payload);
    return {
      success: true,
      message: 'Challenge update message produced successfully',
      data: {
        timestamp: message.timestamp,
        challengeId: message.payload.challengeId,
        status: message.payload.status,
      },
    };
  }

  @Post('command')
  @ApiOperation({ summary: 'Produce a command message to Kafka.' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Message produced successfully.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid message payload.',
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'Internal server error or Kafka producer failure.',
  })
  async produceCommand(@Body() message: CommandMessageDto) {
    await this.autopilotProducer.sendCommand(message.payload);
    return {
      success: true,
      message: 'Command message produced successfully',
      data: {
        timestamp: message.timestamp,
        command: message.payload.command,
        projectId: message.payload.projectId,
      },
    };
  }
}
