import * as React from "react"
import styled from "styled-components"
import { FontAwesomeIcon } from "@fontawesome/react-fontawesome"
import { faSearch } from "@fontawesome/free-solid-svg-icons"

const Element = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
`

const SearchBox = styled.form`
  border: 1px solid var(--grey-1);
  height: 36px;
  width: 224px;
  display: flex;
  flex-direction: row;
  align-items: center;
`

const Input = styled.input`
  padding: 0;
  border: 0;
  font-size: var(--font-size-14);
`

const PaddedIcon = styled(props => <FontAwesomeIcon {...props} />)`
  font-weight: var(--font-weight-bold);
  font-size: var(--font-size-16);
  margin-left: var(--a-vsmall-space);
  margin-right: var(--a-vsmall-space);
`

const Search = ({ searcher: listener }) => {
  const onInputChange = e => {
    listener(e.target.value)
  }

  return (
    <Element>
      <SearchBox>
        <PaddedIcon icon={faSearch} />
        <Input
          id="search-regex"
          name="search-regex"
          placeholder="Find an extension"
          onChange={onInputChange}
        />
      </SearchBox>
    </Element>
  )
}

export default Search
