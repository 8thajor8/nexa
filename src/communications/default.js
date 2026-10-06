import { microsoftAuth } from '../integrations/microsoft/auth.js';
import { createMicrosoftGraphProvider } from './providers/microsoft-graph.js';
import { createCommunicationsService } from './service.js';
export const communicationsService = createCommunicationsService({ emailProvider: createMicrosoftGraphProvider({ auth: microsoftAuth }) });
