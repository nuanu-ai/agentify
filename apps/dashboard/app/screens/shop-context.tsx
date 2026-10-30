import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import { PostForm } from "../components/post-form.js";

export const ProductsShop = createContext(false);

/** Shop presses keep the section they were drawn in. */
export function ShopForm({ action, ...props }: ComponentProps<typeof PostForm>) {
  const onboarding = useContext(ProductsShop);
  return (
    <PostForm
      {...props}
      action={onboarding ? `/products?woo=${action.replace("/woocommerce/", "")}` : action}
    />
  );
}

export function ShopAgain({
  base,
  children,
  className,
}: Readonly<{ base: string; children: ReactNode; className: string | undefined }>) {
  const onboarding = useContext(ProductsShop);
  return (
    <a className={className} href={`${base}${onboarding ? "/products" : "/woocommerce"}`}>
      {children}
    </a>
  );
}
