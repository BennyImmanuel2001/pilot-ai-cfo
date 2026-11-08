import path from 'path';
import dotenv from 'dotenv';

// Load server/.env first, then the repo-root .env (root fills any gaps).
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
