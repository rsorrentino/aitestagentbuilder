/** Where run evidence (screenshots, traces, videos) and visual baselines are stored. */

import { join } from 'path';
import { BACKEND_ROOT } from './env.js';

export const ARTIFACTS_PATH = process.env.ARTIFACTS_PATH || join(BACKEND_ROOT, 'artifacts');
