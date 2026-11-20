// Edit these to match your GitHub repository.
export const REPO = "DucPham1512/qq-clean-reader";
export const REMOTE_RULES_URL = `https://raw.githubusercontent.com/${REPO}/main/rules/rules.json`;

export const UPDATE_PERIOD_MIN = 360;        // check for new rules every 6 hours
export const MAX_REMOTE_BYTES = 100 * 1024;  // refuse oversized rule files
export const MAX_DETECTIONS = 100;           // detections kept on the device
