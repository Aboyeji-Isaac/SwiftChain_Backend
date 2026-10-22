/** Stellar asset identity: native XLM has no issuer; issued tokens require one. */
export interface Asset {
  code: string;
  issuer?: string;
}
