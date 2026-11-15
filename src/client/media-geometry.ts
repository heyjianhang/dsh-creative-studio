/** Fit decoded media into the canvas display limits without cropping or upscaling.
 * @param width Decoded image or video width in pixels.
 * @param height Decoded image or video height in pixels.
 * @returns Content dimensions, or null while metadata is unavailable.
 */
export function mediaNodeSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const scale = Math.min(1, 270 / width, 340 / height);
  return { width: width * scale, height: height * scale };
}
