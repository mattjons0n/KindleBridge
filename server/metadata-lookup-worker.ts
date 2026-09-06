import type {
  MetadataLookupErrorCode,
  MetadataLookupJob,
} from "../shared/catalog-contracts.js";
import { CatalogDatabase } from "./catalog-database.js";
import { CoverProviderError, type CoverProviderClient } from "./cover-providers.js";

export const METADATA_LOOKUP_CONCURRENCY = 2;
export const METADATA_LOOKUP_REQUESTS_PER_SECOND = 4;
export const METADATA_LOOKUP_MAX_ATTEMPTS = 3;
export const METADATA_LOOKUP_STEP_ENTRIES = 2;

type Delay = (milliseconds: number) => Promise<void>;
type MetadataProviderLookup = Pick<CoverProviderClient, "searchMetadata">;

const defaultDelay: Delay = async (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref();
});

/**
 * Executes one deliberately small durable step. The HTTP/client boundary must
 * explicitly resume and request each step; results stop at review-ready rows
 * and never write book overlays. Pausing or cancelling wins over late results
 * in CatalogDatabase.completeMetadataLookupEntry().
 */
export class MetadataLookupWorker {
  /**
   * A non-rejecting latch lets overlapping HTTP callers wait for the active
   * provider step instead of receiving an unchanged running snapshot and
   * immediately polling again. Provider work is still globally bounded to
   * this worker's two-entry step.
   */
  private stepInProgress?: Promise<void>;
  private nextProviderRequestAt = 0;

  constructor(
    private readonly database: CatalogDatabase,
    private readonly provider: MetadataProviderLookup,
    private readonly delay: Delay = defaultDelay,
  ) {}

  async runStep(profileId: string, jobId: string): Promise<MetadataLookupJob> {
    // One application process owns one worker. Wait for an overlapping step
    // to settle before returning this job's durable snapshot; otherwise two
    // browsers can form a hot loop around an unchanged `running` response.
    if (this.stepInProgress) {
      await this.stepInProgress;
      return this.requiredJob(profileId, jobId);
    }
    let releaseStep!: () => void;
    const stepLatch = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });
    this.stepInProgress = stepLatch;
    try {
      const claims = this.database.claimMetadataLookupEntries(profileId, jobId, METADATA_LOOKUP_STEP_ENTRIES);
      await Promise.all(claims.map(async (claim) => {
        let failureCode: MetadataLookupErrorCode = "provider-unavailable";
        for (let attempt = 0; attempt < METADATA_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
          try {
            await this.waitForProviderSlot();
            const candidates = await this.provider.searchMetadata(claim.provider, claim.terms, 12);
            this.database.completeMetadataLookupEntry(profileId, jobId, claim.bookId, candidates, null);
            return;
          } catch (error) {
            const failure = durableLookupFailure(error);
            failureCode = failure.code;
            if (!failure.retryable || attempt + 1 >= METADATA_LOOKUP_MAX_ATTEMPTS) break;
            await this.delay(250 * (2 ** attempt));
          }
        }
        this.database.completeMetadataLookupEntry(profileId, jobId, claim.bookId, [], failureCode);
      }));
      return this.requiredJob(profileId, jobId);
    } finally {
      if (this.stepInProgress === stepLatch) this.stepInProgress = undefined;
      releaseStep();
    }
  }

  private async waitForProviderSlot(): Promise<void> {
    const spacing = Math.ceil(1_000 / METADATA_LOOKUP_REQUESTS_PER_SECOND);
    const current = Date.now();
    const scheduled = Math.max(current, this.nextProviderRequestAt);
    this.nextProviderRequestAt = scheduled + spacing;
    if (scheduled > current) await this.delay(scheduled - current);
  }

  private requiredJob(profileId: string, jobId: string): MetadataLookupJob {
    const job = this.database.getMetadataLookupJob(profileId, jobId);
    if (!job) throw new Error("Metadata lookup job disappeared while its bounded step was running.");
    return job;
  }
}

function durableLookupFailure(error: unknown): { code: MetadataLookupErrorCode; retryable: boolean } {
  if (!(error instanceof CoverProviderError)) {
    return { code: "provider-unavailable", retryable: true };
  }
  switch (error.code) {
    case "provider_unavailable":
      return { code: "provider-unavailable", retryable: true };
    case "provider_timeout":
      return { code: "provider-unavailable", retryable: true };
    case "provider_not_configured":
      return { code: "provider-not-configured", retryable: false };
    case "provider_invalid_token":
      return { code: "provider-unauthorized", retryable: false };
    case "provider_insufficient_permissions":
      return { code: "provider-forbidden", retryable: false };
    case "provider_rate_limited":
      return { code: "provider-rate-limited", retryable: false };
    case "provider_response_too_large":
      return { code: "provider-response-too-large", retryable: false };
    case "invalid_provider":
    case "invalid_candidate":
      return { code: "invalid-provider-response", retryable: false };
  }
}
