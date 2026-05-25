import memberApiConfig from './member-api.config';

describe('memberApiConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses BUS_API_URL when MEMBER_API_URL is absent', () => {
    delete process.env.MEMBER_API_URL;
    process.env.BUS_API_URL = 'https://api.topcoder-dev.com';

    expect(memberApiConfig().baseUrl).toBe('https://api.topcoder-dev.com');
  });

  it('prefers MEMBER_API_URL over BUS_API_URL', () => {
    process.env.MEMBER_API_URL = 'http://member-api:3000';
    process.env.BUS_API_URL = 'https://api.topcoder-dev.com';

    expect(memberApiConfig().baseUrl).toBe('http://member-api:3000');
  });
});
