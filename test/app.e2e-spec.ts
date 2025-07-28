import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { ChallengeApiService } from '../src/challenge/challenge-api.service';
import { Auth0Service } from '../src/auth/auth0.service';
import { KafkaService } from '../src/kafka/kafka.service';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KafkaService)
      .useValue({
        produce: jest.fn(),
        consume: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
      })
      .overrideProvider(Auth0Service)
      .useValue({
        getAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
        clearTokenCache: jest.fn(),
      })
      .overrideProvider(ChallengeApiService)
      .useValue({
        getAllActiveChallenges: jest.fn().mockResolvedValue([]),
        getChallenge: jest.fn().mockResolvedValue(null),
        getChallengeById: jest.fn().mockResolvedValue(null),
        advancePhase: jest.fn().mockResolvedValue({ success: true, message: 'Phase advanced' }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
      });
  });
});
