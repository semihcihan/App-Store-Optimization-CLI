import {
  ASO_STOREFRONT_LANGUAGES_BY_COUNTRY,
  getStorefrontAdditionalLanguages,
  getStorefrontLanguageConfig,
  getStorefrontLanguages,
} from "./aso-storefront-localizations";

describe("aso storefront localizations", () => {
  afterEach(() => {
    delete ASO_STOREFRONT_LANGUAGES_BY_COUNTRY.CA;
  });

  it("supports storefront configs that only define default language", () => {
    ASO_STOREFRONT_LANGUAGES_BY_COUNTRY.CA = {
      defaultLanguage: "en-CA",
    };

    expect(getStorefrontLanguageConfig("CA")).toEqual({
      defaultLanguage: "en-CA",
      additionalLanguages: [],
    });
    expect(getStorefrontAdditionalLanguages("CA")).toEqual([]);
    expect(getStorefrontLanguages("CA")).toEqual(["en-CA"]);
  });
});
