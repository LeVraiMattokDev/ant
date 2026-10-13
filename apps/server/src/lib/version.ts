/** Version shown on the Santé screen and written in `service_status`: ANT_VERSION (set by the deployment, e.g. a git tag), else « dev ». */
export const ANT_VERSION = process.env.ANT_VERSION?.trim() || 'dev';
