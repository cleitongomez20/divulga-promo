import { queryOptions } from '@tanstack/react-query';
import { getConnections } from './connections.functions';
export const connectionsQuery = queryOptions({ queryKey: ['connections'], queryFn: () => getConnections() });