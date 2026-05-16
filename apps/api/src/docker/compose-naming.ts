// docker-compose project names must be lowercase alphanumeric + hyphens.
// Single source of truth — DockerService and DbViewerService both derive the
// project name + network name from this helper so a change here propagates.

export function composeProjectName(envId: string): string {
  return `withvibe-${envId.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
}
