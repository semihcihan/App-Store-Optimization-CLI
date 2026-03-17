1. fetching the order stays the same as is (including the
   fallback)

2. For top apps instead of what we do now, we should use this endpoint
GET https://apps.apple.com/{country}/app/id{appId}?l={language} example
responses are at docs/title-subtitle-refinement\*.json This is already a used
endpoint but we were using its html response, but instead we'll now use the json
inside
<script type="application/json" id="serialized-server-data">
  {json content here}
</script>

the mappings:

name: data[0].data.lockup.title
subtitle: data[0].data.lockup.subtitle
rating: data[0].data.shelfMapping.productRatings.items[0].ratingAverage
ratingCount: data[0].data.shelfMapping.productRatings.items[0].totalNumberOfRatings
