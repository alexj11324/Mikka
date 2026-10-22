"use client";

import { forwardRef } from "react";
import { Magnetic } from "../magnetic";
import { Button, type ButtonProps } from "./base";

export interface MagneticButtonProps extends ButtonProps {
  /** Magnetic pull strength. Default 0.25. */
  strength?: number;
  /** Class applied to the magnetic wrapper. */
  magneticClassName?: string;
}

export const MagneticButton = forwardRef<HTMLButtonElement, MagneticButtonProps>(function MagneticButton(
  { strength = 0.25, magneticClassName, children, onClick, ...rest },
  ref,
) {
  return (
    <Magnetic strength={strength} className={magneticClassName}>
      <Button ref={ref} onClick={onClick} {...rest}>
        {children}
      </Button>
    </Magnetic>
  );
});
