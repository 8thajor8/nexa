import { microsoftAuth } from '../integrations/microsoft/auth.js';
import { createMicrosoftGraphProvider } from './providers/microsoft-graph.js';
import { createCommunicationsService } from './service.js';
const microsoftGraphProvider = createMicrosoftGraphProvider({ auth: microsoftAuth });
export const communicationsService = createCommunicationsService({ emailProvider: microsoftGraphProvider, calendarProvider: microsoftGraphProvider });
