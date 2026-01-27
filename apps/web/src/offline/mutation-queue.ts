import { getDB, type QueuedMutation } from "./db";

const MAX_RETRIES = 5;

export class MutationQueue {
  /**
   * Queue a mutation for later sync.
   * Called when offline and a mutation request is made.
   */
  async enqueue(
    url: string,
    method: "PUT" | "POST" | "DELETE",
    body: unknown
  ): Promise<string> {
    const db = await getDB();
    const mutation: QueuedMutation = {
      id: crypto.randomUUID(),
      url,
      method,
      body,
      timestamp: Date.now(),
      retries: 0,
    };

    await db.add("mutations", mutation);
    return mutation.id;
  }

  /**
   * Get all pending mutations ordered by timestamp.
   */
  async getPending(): Promise<QueuedMutation[]> {
    const db = await getDB();
    const mutations = await db.getAll("mutations");
    return mutations.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get the number of pending mutations.
   */
  async getQueueLength(): Promise<number> {
    const db = await getDB();
    return db.count("mutations");
  }

  /**
   * Process the mutation queue when back online.
   * Returns counts of successful and failed mutations.
   */
  async processQueue(): Promise<{ success: number; failed: number }> {
    const mutations = await this.getPending();
    let success = 0;
    let failed = 0;

    for (const mutation of mutations) {
      // Skip mutations that have exceeded retry limit
      if (mutation.retries >= MAX_RETRIES) {
        console.warn(
          `[MutationQueue] Dropping mutation ${mutation.id} after ${MAX_RETRIES} retries`
        );
        await this.remove(mutation.id);
        failed++;
        continue;
      }

      try {
        const response = await fetch(mutation.url, {
          method: mutation.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mutation.body),
        });

        if (response.ok) {
          await this.remove(mutation.id);
          success++;
        } else if (response.status >= 400 && response.status < 500) {
          // Client error - don't retry
          console.warn(
            `[MutationQueue] Client error for ${mutation.url}: ${response.status}`
          );
          await this.remove(mutation.id);
          failed++;
        } else {
          // Server error - increment retry count
          await this.incrementRetry(mutation.id);
          failed++;
        }
      } catch (error) {
        // Network error - increment retry count
        console.warn(`[MutationQueue] Network error for ${mutation.url}:`, error);
        await this.incrementRetry(mutation.id);
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * Remove a mutation from the queue.
   */
  async remove(id: string): Promise<void> {
    const db = await getDB();
    await db.delete("mutations", id);
  }

  /**
   * Increment retry count for a failed mutation.
   */
  async incrementRetry(id: string): Promise<void> {
    const db = await getDB();
    const mutation = await db.get("mutations", id);
    if (mutation) {
      mutation.retries++;
      await db.put("mutations", mutation);
    }
  }

  /**
   * Clear all mutations (use with caution).
   */
  async clear(): Promise<void> {
    const db = await getDB();
    await db.clear("mutations");
  }
}

// Singleton instance for global access
let mutationQueueInstance: MutationQueue | null = null;

export function getMutationQueue(): MutationQueue {
  if (!mutationQueueInstance) {
    mutationQueueInstance = new MutationQueue();
  }
  return mutationQueueInstance;
}
