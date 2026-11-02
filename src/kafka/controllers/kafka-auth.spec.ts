import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AuthModule } from '../../auth/auth.module';
import { AutopilotProducer } from '../producers/autopilot.producer';
import { KafkaController } from './kafka.controller';

const secret = 'fixture-autopilot-key-at-least-32-bytes';

/** Exercises real Passport/JWT authorization before mocked Kafka publication. */
describe('Kafka publishing authorization', () => {
  let app: INestApplication;
  const producer = {
    sendCommand: jest.fn().mockResolvedValue(undefined),
    sendChallengeUpdate: jest.fn().mockResolvedValue(undefined),
    sendPhaseTransition: jest.fn().mockResolvedValue(undefined),
  };
  const signer = new JwtService({ secret });
  const sign = (audience = 'autopilot-v6', expiresIn = 3600) =>
    signer.sign(
      { sub: '1', username: 'fixture' },
      {
        issuer: 'autopilot-v6',
        audience,
        expiresIn,
      },
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ jwt: { secret, expiresIn: '1h' } })],
        }),
        AuthModule,
      ],
      controllers: [KafkaController],
      providers: [{ provide: AutopilotProducer, useValue: producer }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it.each(['command', 'challenge-update', 'phase-transition'])(
    'rejects missing, malformed, expired and wrong-audience tokens on %s',
    async (route) => {
      for (const token of [
        undefined,
        'invalid',
        sign('other-api'),
        sign('autopilot-v6', -3600),
      ]) {
        const call = request(app.getHttpServer())
          .post(`/kafka/${route}`)
          .send({});
        if (token) call.set('Authorization', `Bearer ${token}`);
        await call.expect(401);
      }
      for (const publish of Object.values(producer))
        expect(publish).not.toHaveBeenCalled();
    },
  );

  it('publishes once for an authenticated local operator', async () => {
    const payload = { command: 'fixture-command', operator: 'system' };
    await request(app.getHttpServer())
      .post('/kafka/command')
      .set('Authorization', `Bearer ${sign()}`)
      .send({ timestamp: '2026-11-02T00:00:00Z', payload })
      .expect(201);
    expect(producer.sendCommand).toHaveBeenCalledTimes(1);
    expect(producer.sendCommand).toHaveBeenCalledWith(payload);
  });
});
