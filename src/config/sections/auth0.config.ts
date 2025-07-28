import { registerAs } from '@nestjs/config';

export default registerAs('auth0', () => ({
  url: process.env.AUTH0_URL,
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  domain: process.env.AUTH0_DOMAIN,
  audience: process.env.AUTH0_AUDIENCE,
  proxyServerUrl: process.env.AUTH0_PROXY_SEREVR_URL,
}));
