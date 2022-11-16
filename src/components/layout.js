import * as React from "react"
import Navigation from "./navigation"
import HeroBar from "./hero-bar"

import { library } from "@fontawesome/fontawesome-svg-core"

import {
  faAngleRight,
  faClipboard,
  faClipboardCheck,
  faR,
  faSquareCheck,
} from "@fontawesome/free-solid-svg-icons"

import { faSquare } from "@fontawesome/free-regular-svg-icons"

library.add(
  faAngleRight,
  faClipboard,
  faClipboardCheck,
  faSquare,
  faSquareCheck,
  faR
)

const Layout = ({ location, title, children }) => {
  const rootPath = `${__PATH_PREFIX__}/`
  const isRootPath = location.pathname === rootPath
  let header

  if (isRootPath) {
    header = (
      <div>
        <Navigation />
        <HeroBar title={title} />
      </div>
    )
  } else {
    header = (
      <div>
        <Navigation />
      </div>
    )
  }

  return (
    <div
      className="global-wrapper"
      data-is-root-path={isRootPath}
      style={{ width: "1920px" }}
    >
      <header className="global-header">{header}</header>
      {children}
    </div>
  )
}

export default Layout
