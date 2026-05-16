export type DisplayMember = {
  userId: string;
  name: string | null;
  email: string;
};

/**
 * Return a compact display label for a member, disambiguated against the
 * other members they share a scope with.
 *
 * Rules, most to least preferred:
 * 1. First name (if unique among the group)
 * 2. "First L." with last-initial (if that variant is unique)
 * 3. Full name (if still unique)
 * 4. Full name + email (last resort)
 *
 * Members with no `name` fall through to their email.
 */
export function displayName(
  target: DisplayMember,
  all: readonly DisplayMember[]
): string {
  const raw = target.name?.trim();
  if (!raw) return target.email;

  const parts = raw.split(/\s+/).filter(Boolean);
  const first = parts[0];

  const others = all.filter((m) => m.userId !== target.userId);

  const firstCollisions = others.filter((m) => {
    const otherFirst = m.name?.trim().split(/\s+/)[0];
    return otherFirst?.toLowerCase() === first.toLowerCase();
  });
  if (firstCollisions.length === 0) return first;

  if (parts.length > 1) {
    const lastInitial = parts[parts.length - 1][0].toUpperCase();
    const variant = `${first} ${lastInitial}.`;
    const initialCollisions = firstCollisions.filter((m) => {
      const cparts = m.name?.trim().split(/\s+/).filter(Boolean) ?? [];
      if (cparts.length < 2) return false;
      return cparts[cparts.length - 1][0].toUpperCase() === lastInitial;
    });
    if (initialCollisions.length === 0) return variant;
  }

  const fullCollisions = firstCollisions.filter(
    (m) => m.name?.trim().toLowerCase() === raw.toLowerCase()
  );
  if (fullCollisions.length === 0) return raw;

  return `${raw} <${target.email}>`;
}
