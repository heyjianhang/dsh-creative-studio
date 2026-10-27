import volcengine from "./assets/volcengine.svg";
import bytedance from "./assets/bytedance.svg";
import css from "./studio.module.css";

export function ProviderIcon({
  model = false,
  size = 20,
}: {
  model?: boolean;
  size?: number;
}) {
  return model ? (
    <img
      aria-hidden
      className={css.modelBrandIcon}
      src={bytedance}
      width={size}
      height={size}
      alt=""
    />
  ) : (
    <img
      aria-hidden
      className={css.providerBrandIcon}
      src={volcengine}
      width={size}
      height={size}
      alt=""
    />
  );
}
