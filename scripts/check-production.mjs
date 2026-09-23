import 'dotenv/config';
import { checkProductionConfig } from '../dist/lib/productionConfig.js';

const { errors, warnings } = checkProductionConfig(process.env);
for (const error of errors) console.error(`FAIL: ${error}`);
for (const warning of warnings) console.warn(`REVIEW: ${warning}`);
if (!errors.length) console.log('PASS: required production configuration is present. Verify provider connections and deployed flows separately.');
process.exitCode = errors.length ? 1 : 0;
