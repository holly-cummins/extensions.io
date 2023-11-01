const gh = require("parse-github-url")
const path = require("path")
const encodeUrl = require("encodeurl")

const { getCache } = require("gatsby/dist/utils/get-cache")
const { createRemoteFileNode } = require("gatsby-source-filesystem")
const { labelExtractor } = require("./labelExtractor")
const PersistableCache = require("./persistable-cache")
const { findSponsor, clearCaches, saveSponsorCache, initSponsorCache, getContributors } = require("./sponsorFinder")
const { getRawFileContents, queryGraphQl } = require("./github-helper")

const defaultOptions = {
  nodeType: "Extension",
}

// To avoid hitting the git rate limiter retrieving information we already know, cache what we can
const DAY_IN_SECONDS = 24 * 60 * 60

// Defer initialization of these so we're playing at the right points in the plugin lifecycle
let imageCache, extensionYamlCache, issueCountCache

let getLabels

exports.onPreBootstrap = async ({}) => {
  imageCache = new PersistableCache({ key: "github-api-for-images", stdTTL: 3 * DAY_IN_SECONDS })

// The location of extension files is unlikely to change often, and if it does, the link checker will flag the issue
  extensionYamlCache = new PersistableCache({
    key: "github-api-for-extension-paths",
    stdTTL: 10 * DAY_IN_SECONDS
  })

  issueCountCache = new PersistableCache({
    key: "github-api-for-issue-count",
    stdTTL: 1 * DAY_IN_SECONDS
  })

  await imageCache.ready()
  console.log("Ingested", imageCache.size(), "cached images.")

  await extensionYamlCache.ready()
  console.log("Ingested", extensionYamlCache.size(), "cached metadata file locations.")

  await issueCountCache.ready()
  console.log("Ingested", issueCountCache.size(), "cached issue counts.")

  await initSponsorCache()

  const repoCoords = { owner: "quarkusio", name: "quarkus" }

  const text = await getRawFileContents(repoCoords.owner, repoCoords.name, ".github/quarkus-github-bot.yml")

  const yaml = text ? text : ""

  // This query is long, because I can't find a way to do "or" or
  // Batching this may not help that much because rate limits are done on query complexity and cost,
  // not the number of actual http calls; see https://docs.github.com/en/graphql/overview/resource-limitations
  const query = `
  query {
    repository(owner:"${repoCoords.owner}", name:"${repoCoords.name}") {
     object(expression: "HEAD:extensions") {
      # Top-level.
      ... on Tree {
        entries {
          name
          type
          object {

            # One level down.
            ... on Tree {
              entries {
                name
                type
              }
            }
          }
        }
      }
    }
  }
}`

  const pathsRes = await queryGraphQl(query)
  const repoListing = pathsRes?.repository?.object?.entries

  getLabels = labelExtractor(yaml, repoListing).getLabels

  // Return the promise so the execution waits for us
  return yaml
}

exports.onPostBootstrap = async ({}) => {
  await imageCache.persist()
  console.log("Persisted", imageCache.size(), "cached repository images.")

  await extensionYamlCache.persist()
  console.log("Persisted", extensionYamlCache.size(), "cached metadata file locations.")

  await issueCountCache.persist()
  console.log("Persisted", issueCountCache.size(), "issue counts.")

  await saveSponsorCache()
}

exports.onPluginInit = () => {
  // Clear the in-memory cache; we read from the gatsby cache later on, so this shouldn't affect the persistence between builds
  // This is mostly needed for tests, since we can't add new methods beyond what the API defines to this file
  imageCache?.flushAll()
  extensionYamlCache?.flushAll()
  issueCountCache?.flushAll()
  clearCaches()
}

exports.onCreateNode = async (
  { node, actions, createNodeId, createContentDigest },
  pluginOptions
) => {
  const { createNode } = actions

  const options = {
    ...defaultOptions,
    ...pluginOptions,
  }

  if (node.internal.type !== options.nodeType) {
    return
  }

  const { metadata } = node
  // A bit ugly, we need a unique identifier in string form, and we also need the url; use a comma-separated string
  const id = metadata?.sourceControl
  const scmUrl = id?.split(",")[0]

  if (scmUrl) {
    const labels = await fetchScmLabel(scmUrl, node.metadata?.maven?.artifactId)

    const scmInfo = await fetchScmInfo(
      scmUrl,
      node.metadata?.maven?.groupId,
      node.metadata?.maven?.artifactId,
      labels
    )

    scmInfo.id = createNodeId(id)
    // We need a non-obfuscated version of the id to act as a foreign key
    scmInfo.key = id

    scmInfo.internal = {
      type: "SourceControlInfo",
      contentDigest: createContentDigest(scmInfo),
    }

    if (scmInfo.socialImage) {
      const fileNode = await createRemoteFileNode({
        url: scmInfo.socialImage,
        name: path.basename(scmInfo.socialImage),
        parentNodeId: scmInfo.id,
        getCache,
        createNode,
        createNodeId,
      })

      // This is the foreign key to the cropped file's name
      // We have to guess what the name will be
      scmInfo.projectImage = "smartcrop-" + path.basename(fileNode.absolutePath)
    }

    createNode(scmInfo)

    // Return a promise to make sure we wait
    return scmInfo
  }
}

async function fetchScmLabel(scmUrl, artifactId) {
  // Special case extensions which live in the quarkus repo; in the future we could generalise,
  // but at the moment we only know how to find a label for quarkus
  if (scmUrl === "https://github.com/quarkusio/quarkus") {
    return getLabels(artifactId)
  }
}

const fetchScmInfo = async (scmUrl, groupId, artifactId, labels) => {
  if (scmUrl && scmUrl.includes("github.com")) {
    return fetchGitHubInfo(scmUrl, groupId, artifactId, labels)
  } else {
    return { url: scmUrl }
  }
}


const fetchGitHubInfo = async (scmUrl, groupId, artifactId, labels) => {

  const coords = gh(scmUrl)

  const project = coords.name

  const scmInfo = { url: scmUrl, project }

  const { issuesUrl, issues } = await getIssueInformation(coords, labels, scmUrl)

  scmInfo.issuesUrl = issuesUrl
  scmInfo.issues = issues

  scmInfo.labels = labels

  const imageInfo = await getImageInformation(coords, scmUrl)

  if (imageInfo) {
    const { ownerImageUrl, socialImage } = imageInfo

    scmInfo.ownerImageUrl = ownerImageUrl
    scmInfo.socialImage = socialImage
  }


  const metadataInfo = await getMetadataPath(coords, groupId, artifactId, scmUrl)
  if (metadataInfo) {
    const {
      extensionYamlUrl,
      extensionPathInRepo,
      extensionRootUrl
    } = metadataInfo
    scmInfo.extensionYamlUrl = extensionYamlUrl
    scmInfo.extensionPathInRepo = extensionPathInRepo
    scmInfo.extensionRootUrl = extensionRootUrl
  } else {
    console.warn("Could not locate the extension metadata path for", artifactId)
  }

  // scmInfo.extensionPathInRepo may be undefined, but these methods will cope with that
  scmInfo.sponsors = await findSponsor(coords.owner, project, scmInfo.extensionPathInRepo)
  scmInfo.contributors = await getContributors(coords.owner, project, scmInfo.extensionPathInRepo)

  scmInfo.owner = coords.owner

  return scmInfo
}

const getImageInformation = async (coords, scmUrl) => {
  const repoKey = scmUrl
  return await imageCache.getOrSet(repoKey, () => getImageInformationNoCache(coords))
}

const getImageInformationNoCache = async (coords) => {
  const query = `query {
    repository(owner:"${coords.owner}", name:"${coords.name}") {               
      openGraphImageUrl
    }
    
    repositoryOwner(login: "${coords.owner}") {
        avatarUrl
    }
  }`

  const body = await queryGraphQl(query)

  // Don't try and destructure undefined things
  if (body?.data?.repository) {
    const {
      repository: {
        openGraphImageUrl,
      },
      repositoryOwner: {
        avatarUrl
      }
    } = body.data

    const ownerImageUrl = avatarUrl

    // Only look at the social media preview if it's been set by the user; otherwise we know it will be the owner avatar with some text we don't want
    // This mechanism is a bit fragile, but should work for now
    // Default pattern https://opengraph.githubassets.com/3096043220541a8ea73deb5cb6baddf0f01d50244737d22402ba12d665e9aec2/quarkiverse/quarkus-openfga-client
    // Customised pattern https://repository-images.githubusercontent.com/437045322/39ad4dec-e606-4b21-bb24-4c09a4790b58

    const isCustomizedSocialMediaPreview =
      openGraphImageUrl?.includes("githubusercontent")

    let socialImage

    if (isCustomizedSocialMediaPreview) {
      socialImage = openGraphImageUrl
    }

    return { socialImage, ownerImageUrl }
  }

}

const getMetadataPath = async (coords, groupId, artifactId, scmUrl) => {
  const artifactKey = groupId + ":" + artifactId
  return await extensionYamlCache.getOrSet(artifactKey, () => getMetadataPathNoCache(coords, groupId, artifactId, scmUrl))
}

const getMetadataPathNoCache = async (coords, groupId, artifactId, scmUrl) => {

  // Some multi-extension projects use just the 'different' part of the name in the folder structure
  const shortArtifactId = artifactId?.replace(coords.name + "-", "")

  const query = `query {
        repository(owner:"${coords.owner}", name:"${coords.name}") {    
            defaultBranchRef {
              name
            }
            
            metaInfs: object(expression: "HEAD:runtime/src/main/resources/META-INF/") {
              ... on Tree {
                entries {
                  path
                }
              }
            }
            
            subfolderMetaInfs: object(expression: "HEAD:${artifactId}/runtime/src/main/resources/META-INF/") {
              ... on Tree {
                entries {
                  path
                }
              }
            }
            
            shortenedSubfolderMetaInfs: object(expression: "HEAD:${shortArtifactId}/runtime/src/main/resources/META-INF/") {
              ... on Tree {
                entries {
                  path
                }
              }
            }
            
             quarkusSubfolderMetaInfs: object(expression: "HEAD:extensions/${shortArtifactId}/runtime/src/main/resources/META-INF/") {
              ... on Tree {
                entries {
                  path
                }
              }
            }
            
            camelQuarkusCoreSubfolderMetaInfs: object(expression: "HEAD:extensions-core/${shortArtifactId}/runtime/src/main/resources/META-INF/") {
              ... on Tree {
                entries {
                  path
                }
              }
            }
            
            camelQuarkusJvmSubfolderMetaInfs: object(expression: "HEAD:extensions-jvm/${shortArtifactId}/runtime/src/main/resources/META-INF/") {
              ... on Tree {
                entries {
                  path
                }
              }
            }
            
            camelQuarkusSupportSubfolderMetaInfs: object(expression: "HEAD:extensions-support/${shortArtifactId}/runtime/src/main/resources/META-INF/") {
              ... on Tree {
                entries {
                  path
                }
              }
          }
        }
    }`

  const body = await queryGraphQl(query)
  const data = body?.data

  // If we got rate limited, there may not be a repository field
  if (data?.repository) {
    const defaultBranchRef = data.repository.defaultBranchRef

    const allMetaInfs = Object.values(data.repository).map(e => e?.entries).flat()

    const extensionYamls = allMetaInfs.filter(entry =>
      entry?.path.endsWith("/quarkus-extension.yaml")
    )
    // We should only have one extension yaml - if we have more, don't guess, and if we have less, don't set anything
    if (extensionYamls.length === 1) {

      const extensionYamlPath = extensionYamls[0].path
      const extensionPathInRepo = extensionYamlPath.replace("runtime/src/main/resources/META-INF/quarkus-extension.yaml", "")
      const extensionRootUrl = `${scmUrl}/blob/${defaultBranchRef.name}/${extensionPathInRepo}`
      const extensionYamlUrl = `${scmUrl}/blob/${defaultBranchRef.name}/${extensionYamlPath}`

      return { extensionYamlUrl, extensionPathInRepo, extensionRootUrl }

    } else {
      console.warn(`Could not identify the extension yaml path for ${groupId}:${artifactId}; found `, extensionYamls)
    }
  }

}

const getIssueInformation = async (coords, labels, scmUrl) => {
  const key = labels ? labels.map(label => `"${label}"`).join() : `${coords.owner}-${coords.name}`
  return await issueCountCache.getOrSet(
    key,
    () => getIssueInformationNoCache(coords, labels, scmUrl)
  )
}

const getIssueInformationNoCache = async (coords, labels, scmUrl) => {

  // TODO we can just treat label as an array, almost
  const labelFilterString = labels
    ? `, filterBy: { labels:  [${labels.map(label => `"${label}"`).join()}] }`
    : ""

  const issuesUrl = labels
    ? encodeUrl(
      scmUrl +
      "/issues?q=is%3Aopen+is%3Aissue+label%3A" +
      labels.map(label => label.replace("/", "%2F")).join(",")
    )
    : scmUrl + "/issues"

  // Batching this with other queries is not needed because rate limits are done on query complexity and cost,
  // not the number of actual http calls; see https://docs.github.com/en/graphql/overview/resource-limitations
  const query = `query {
          repository(owner:"${coords.owner}", name:"${coords.name}") {
            issues(states:OPEN, ${labelFilterString}) {
                    totalCount
                  }
                }
        }`

  const body = query ? await queryGraphQl(query) : undefined

  // The parent objects may be undefined and destructuring nested undefineds is not good
  const issues = body?.data?.repository?.issues?.totalCount

  return { issues, issuesUrl }
}

exports.createSchemaCustomization = ({ actions }) => {
  const { createTypes } = actions
  const typeDefs = `
  type SourceControlInfo implements Node @noinfer {
    url: String
    ownerImageUrl: String
    companies: [String]
    extensionYamlUrl: String
    issues: String
    contributors: [ContributorInfo]
    sponsors: [String]
    socialImage: File @link(by: "url")
    projectImage: File @link(by: "name")
  }
  
  type ContributorInfo implements Node @noinfer {
    name: String
    login: String
    contributions: Int
    url: String
  }
  `
  createTypes(typeDefs)
}
