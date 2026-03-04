import db from "../db/index.js";
import { pages, spaces, spaceMembers, pageShares } from "../db/schema.js";
import { eq, and, or } from "drizzle-orm";

export type AccessLevel = "view" | "edit" | "owner";

const ACCESS_HIERARCHY: Record<AccessLevel, number> = {
  view: 1,
  edit: 2,
  owner: 3,
};

function meetsLevel(actual: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_HIERARCHY[actual] >= ACCESS_HIERARCHY[required];
}

/**
 * Check if a user can access a page at the required level.
 * Resolution order:
 *   1. Space owner → full access
 *   2. Space member → editor access
 *   3. Direct page share → per permission field
 *   4. Ancestor share with includeChildren → walk up parentId chain
 */
export async function canAccessPage(
  userId: string,
  pageId: string,
  requiredLevel: AccessLevel
): Promise<boolean> {
  // Get the page and its space info
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
  });
  if (!page) return false;

  // 1. Check space ownership
  const space = await db.query.spaces.findFirst({
    where: eq(spaces.id, page.spaceId),
  });
  if (space && space.ownerId === userId) return true;

  // 2. Check space membership
  if (space) {
    const member = await db.query.spaceMembers.findFirst({
      where: and(
        eq(spaceMembers.spaceId, space.id),
        eq(spaceMembers.userId, userId)
      ),
    });
    if (member) {
      // Members have editor access
      return meetsLevel("edit", requiredLevel);
    }
  }

  // 3. Check direct page share
  const directShare = await db.query.pageShares.findFirst({
    where: and(
      eq(pageShares.pageId, pageId),
      eq(pageShares.userId, userId)
    ),
  });
  if (directShare) {
    return meetsLevel(directShare.permission as AccessLevel, requiredLevel);
  }

  // 4. Walk up parent chain checking for includeChildren shares
  let currentParentId = page.parentId;
  const visited = new Set<string>();

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);

    const ancestorShare = await db.query.pageShares.findFirst({
      where: and(
        eq(pageShares.pageId, currentParentId),
        eq(pageShares.userId, userId),
        eq(pageShares.includeChildren, true)
      ),
    });
    if (ancestorShare) {
      return meetsLevel(ancestorShare.permission as AccessLevel, requiredLevel);
    }

    const parentPage = await db.query.pages.findFirst({
      where: eq(pages.id, currentParentId),
    });
    currentParentId = parentPage?.parentId ?? null;
  }

  return false;
}

/**
 * Get all spaces a user can access (owner or member).
 */
export async function getAccessibleSpaces(userId: string) {
  const ownedSpaces = await db
    .select()
    .from(spaces)
    .where(eq(spaces.ownerId, userId));

  const memberEntries = await db
    .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, userId));

  const ownedSpaceIds = new Set(ownedSpaces.map((s) => s.id));
  const memberSpaceIds = memberEntries
    .map((m) => m.spaceId)
    .filter((id) => !ownedSpaceIds.has(id));

  let memberSpaces: (typeof ownedSpaces) = [];
  if (memberSpaceIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    memberSpaces = await db
      .select()
      .from(spaces)
      .where(inArray(spaces.id, memberSpaceIds));
  }

  return {
    owned: ownedSpaces,
    member: memberSpaces.map((s) => ({
      ...s,
      role: memberEntries.find((m) => m.spaceId === s.id)?.role || "editor",
    })),
  };
}

/**
 * Get pages shared directly with a user.
 */
export async function getSharedPages(userId: string) {
  const shares = await db
    .select({
      shareId: pageShares.id,
      pageId: pageShares.pageId,
      permission: pageShares.permission,
      includeChildren: pageShares.includeChildren,
      createdAt: pageShares.createdAt,
      pageTitle: pages.title,
      pageParentId: pages.parentId,
      pageSpaceId: pages.spaceId,
    })
    .from(pageShares)
    .innerJoin(pages, eq(pageShares.pageId, pages.id))
    .where(eq(pageShares.userId, userId));

  return shares;
}

/**
 * Check if user has access to a space (owner or member).
 */
export async function canAccessSpace(
  userId: string,
  spaceId: string,
  requiredLevel: "view" | "edit" | "owner" = "view"
): Promise<boolean> {
  const space = await db.query.spaces.findFirst({
    where: eq(spaces.id, spaceId),
  });
  if (!space) return false;

  // Owner has full access
  if (space.ownerId === userId) return true;

  // Check membership
  const member = await db.query.spaceMembers.findFirst({
    where: and(
      eq(spaceMembers.spaceId, spaceId),
      eq(spaceMembers.userId, userId)
    ),
  });

  if (!member) return false;

  if (requiredLevel === "owner") return false;
  return true; // Members have at least edit access
}
