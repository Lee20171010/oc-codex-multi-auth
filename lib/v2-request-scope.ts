import { AsyncLocalStorage } from "node:async_hooks";

type V2ModelRequest = {
 model: string;
 context: number;
 /** Selected candidate, not a claim that it served the request. No credentials cross this boundary. */
 onAccountSelected?: (candidate: { index: number; models: Promise<Record<string, unknown>[]> }) => Promise<void>;
};
const requests = new AsyncLocalStorage<V2ModelRequest>();
export const getV2ModelRequest = () => requests.getStore();
export function withV2ModelRequest<T>(request: V2ModelRequest, operation: () => T): T {
 return requests.run(request, operation);
}
