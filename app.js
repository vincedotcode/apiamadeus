
const express = require("express");
const { format, addDays } = require("date-fns");
const bodyParser = require("body-parser");
const path = require("path");
const cors = require('cors');
const dotenv = require("dotenv");
const Bottleneck = require("bottleneck");
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const amadeus = require("./amadeusClient");

dotenv.config();


const PORT = process.env.PORT || "3000";
if (!process.env.AMADEUS_CLIENT_ID)
  throw new Error("AMADEUS_CLIENT_ID environment variable could not be read");
if (!process.env.AMADEUS_CLIENT_SECRET)
  throw new Error(
    "AMADEUS_CLIENT_SECRET environment variable could not be read"
  );

//Configure express
let app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', '..', 'front', 'build')));
//Add logger
app.use((req, _, next) => {
  let requestReceived = new Date();
  req.on('end', () => {
    let time = (Date.now() - requestReceived.getTime())/1000;
    console.log(`Request from ${req.ip} at ${requestReceived.toLocaleString()} completed in ${time.toFixed(2)}s. ${req.method} ${req.url.split('?')[0]}.`);
  });
  next();
})
const allowedOrigins = ['http://localhost:3000', 'https://amadeusflight.onrender.com', 'https://gotreep.netlify.app', 'http://localhost:5000'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));
//Configure Amadeus
const AMADEUS_HOST = process.env.AMADEUS_ENV || "test";


// Configure bottleneck based on API rate limits for different environments
// Test - 10 tx/sec - No more than one request each 100ms
// Production - 40tx/sec
let limiterArgs;
if (AMADEUS_HOST === 'test') {
  limiterArgs = {
    minTime: 100,
    maxConcurrent: 50
  }
} else {
  limiterArgs = {
    reservoir: 40,
    reservoirRefreshAmount: 40,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 50
  }
}
const limiter = new Bottleneck(limiterArgs);


// Swagger definition
const swaggerDefinition = {
    info: {
      title: 'Amadeus Flight API',
      version: '1.0.0',
      description: 'Amadeus Flight API with Swagger',
    },
    basePath: '/',
  };
  
  // Options for the swagger docs
  const options = {
    swaggerDefinition,
    // Paths to files containing OpenAPI definitions
    servers: [
        {
          url: 'https://amadeusflight.onrender.com',
        },
      ],
    apis: ['app.js'],
  };
  
  const swaggerSpec = swaggerJsdoc(options);
  
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  


// ======================= HELPER FUNCTIONS =======================

/**
 * Helper function to convert an uppercase string to first-letter uppercase
 * Ex.: NEW YORK CITY -> New York City
 * @param {string} str Input uppercase string
 * @returns {string} Output
 */
function formatString(str) {
    return str
      .split(/[ -]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }
  
  /**
   * Helper function to convert a string in the format PTxxHyyM to xx h yy m
   * Takes into account special cases when hours or minutes are equal to zero
   * @param str Input value
   * @return Formatted string
   */
  function formatDuration(str) {
    let hasHours = str.includes("H");
    let hasMinutes = str.includes("M");
    let durationHours = hasHours ? str.split("PT")[1].split("H")[0] : "0";
    let durationMinutes;
    let formatted;
  
    if (hasHours && hasMinutes) {
      durationMinutes = str.split("PT")[1].split("H")[1].split("M")[0];
      formatted = `${durationHours} h ${durationMinutes} min`;
    } else if (hasMinutes) {
      durationMinutes = str.split("PT")[1].split("M")[0];
      formatted = `${durationMinutes} min`;
    } else {
      formatted = `${durationHours} h`;
    }
  
    return formatted;
  }
  
  function sameOutbound(it1, it2) {
    if (it1.segments.length != it2.segments.length) return false;
    let it1Flights = it1.segments.map((seg) => seg.carrierCode + seg.carrierName);
    let it2Flights = it2.segments.map((seg) => seg.carrierCode + seg.carrierName);
    return it1Flights.every((flight) => it2Flights.includes(flight));
  }
  
  function generateCalendarDatepairs(departureDate, returnDate) {
    let datepairs = [];
    let _departure = new Date(departureDate);
    let _return = new Date(returnDate);
    for (let i = -3; i <= 3; i++) {
      let newDeparture = addDays(_departure, i);
      for (let j = -3; j <= 3; j++) {
        let newReturn = addDays(_return, j);
        datepairs.push(
          `${format(newDeparture, "yyyy-MM-dd")}>${format(newReturn, "yyyy-MM-dd")}`
        );
      }
    }
    return datepairs;
  }
  



function getSearchSuggestions(keyword) {
    return new Promise((resolve, reject) => {
      amadeus.referenceData.locations
        .get({
          subType: amadeus.location.any,
          keyword: keyword,
        })
        .then((response) => {
          let suggestions = response.result.data.map((entry) => {
            return {
              iataCode: entry.iataCode,
              name: formatString(entry.name),
              cityName: formatString(entry.address.cityName),
            };
          });
          resolve(suggestions);
        })
        .catch((err) => reject(err));
    });
  }



  function getFlightOffers(
    originLocationCode,
    destinationLocationCode,
    departureDate,
    returnDate,
    adults,
    travelClass
  ) {
    return limiter
      .schedule(() =>
        amadeus.shopping.flightOffersSearch.get({
          originLocationCode,
          destinationLocationCode,
          departureDate,
          returnDate,
          adults,
          travelClass,
        })
      )
      .then((res) => {
        let response = JSON.parse(res.body);
        const currencyFormatter = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: response.data[0].price.currency,
        });



        let offers = [];
        response.data.forEach((offer) => {
          let offerData = {};
          console.log("Processing offer:", offer);
          offerData.priceFrom = currencyFormatter.format(offer.price.total);
          offerData.validatingAirline = offer.validatingAirlineCodes[0];
          console.log("Price : ", priceFrom)
          offer.itineraries.forEach((itinerary, i) => {
            let itineraryData = {};
            console.log("Processing itinerary:", itinerary);
            let nbSegments = itinerary.segments.length;
            itineraryData.duration = formatDuration(itinerary.duration);
            itineraryData.stops = `${nbSegments == 1
                ? "Nonstop"
                : nbSegments - 1 + " stop" + (nbSegments >= 3 ? "s" : "")
              }`;
  
            itineraryData.segments = itinerary.segments.map(
              (segment, i) => {
                let segmentData = {};
                console.log("Processing segment:", segment);
                let segmentArrivalTime = new Date(segment.arrival.at);
                let carrierCode =
                  segment.operating?.carrierCode || segment.carrierCode;
                segmentData.departureDate = format(
                  new Date(segment.departure.at),
                  "EEEE, d MMMM"
                );
                segmentData.arrivalDate = format(
                  new Date(segment.arrival.at),
                  "EEEE, d MMMM"
                );
                segmentData.departureTime = format(
                  new Date(segment.departure.at),
                  "HH:mm"
                );
                segmentData.arrivalTime = format(segmentArrivalTime, "HH:mm");
                segmentData.duration = formatDuration(segment.duration);
                segmentData.origin = segment.departure.iataCode;
                segmentData.destination = segment.arrival.iataCode;
                segmentData.carrierCode = carrierCode;
                segmentData.carrierName = formatString(
                  response.dictionaries.carriers[carrierCode]
                );
                segmentData.flightNumber = segment.number;
                segmentData.aircraft = formatString(
                  response.dictionaries.aircraft[segment.aircraft.code]
                );
                segmentData.class =
                  formatString(
                    offer.travelerPricings[0].fareDetailsBySegment
                      .find((fd) => fd.segmentId === segment.id)
                      .cabin.replace("_", " ")
                  ) || "";
  
                if (i === 0) {
                  itineraryData.departureAirport = segment.departure.iataCode;
                  itineraryData.departureTime = segmentData.departureTime;
                  itineraryData.departureDate = segmentData.departureDate;
                }
                if (i === itinerary.segments.length - 1) {
                  itineraryData.arrivalAirport = segment.arrival.iataCode;
                  itineraryData.arrivalTime = segmentData.arrivalTime;
                  itineraryData.arrivalDate = segmentData.arrivalDate;
                }
  
                if (i < nbSegments - 1) {
                  let nextDeparture = new Date(
                    itinerary.segments[i + 1].departure.at
                  );
                  let stopTime =
                    nextDeparture.getTime() - segmentArrivalTime.getTime();
                  let minutes = (stopTime / (60 * 1000)) % 60;
                  let hours = Math.floor(stopTime / (60 * 60 * 1000));
                  segmentData.stopDuration = `${hours} h ${minutes} min`;
                }
                console.log("Segment data after processing:", segmentData);
                return segmentData;
              }
            );
            console.log("Itinerary data after processing:", itineraryData);
            if (i === 0) offerData.outbound = itineraryData;
            
            else {
              offerData.inbounds = [itineraryData];
              itineraryData.priceFormatted = offerData.priceFrom;
              itineraryData.offerId = offer.id;
              offers.forEach((offer) => {
                if (sameOutbound(offer.outbound, offerData.outbound)) {
                  offer.inbounds.push(itineraryData);
                  offerData.added = true;
                }
              });
            }
          });
          if (!offerData.added) offers.push(offerData);
        });
  
        return offers;
      })
      .catch((err) => {
        return err;
      });
  }
  

  function pricesForDatepairs(
    origin,
    destination,
    adults,
    travelClass,
    datepairs
  ) {
    return new Promise((resolve, reject) => {
      let flights = {};
      let responseCount = 0;
      let errorCount = 0;
  
      datepairs.forEach((datepair) => {
        let currentDeparture = datepair.split(">")[0];
        let currentReturn = datepair.split(">")[1];
        limiter
          .schedule(() =>
            amadeus.shopping.flightOffersSearch.get({
              originLocationCode: origin,
              destinationLocationCode: destination,
              departureDate: currentDeparture,
              returnDate: currentReturn,
              adults: adults,
              max: 1,
              travelClass: travelClass,
            })
          )
          .then((response) => {
            const currencyFormatter = new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: response.data[0].price.currency,
            });
            flights[datepair] = {
              price: parseFloat(response.data[0].price.total),
              priceFormatted: currencyFormatter.format(
                response.data[0].price.total
              ),
            };
          })
          .catch((_) => {
            errorCount++;
            flights[datepair] = {};
          })
          .finally(() => {
            responseCount++;
            if (responseCount === datepairs.length) {
              console.log(
                `Request completed with ${responseCount - errorCount
                } successes and ${errorCount} errors.`
              );
              resolve(flights);
            }
          });
      });
    });
  }
  

  app.listen(PORT, () => {
    console.log(`Server started successfully\nEnvironment: ${AMADEUS_HOST}\nListening on port ${PORT}`);
  });


  /**
 * @swagger
 * /search-suggestions:
 *  get:
 *    description: Get search suggestions
 *    parameters:
 *      - in: query
 *        name: keyword
 *        schema:
 *          type: string
 *        required: true
 *        description: Keyword to search for
 *    responses:
 *      '200':
 *        description: Successful response
 */
  app.get("/search-suggestions", (req, res) => {
    getSearchSuggestions(req.query.keyword)
      .then((suggestions) => res.send(suggestions))
      .catch((err) => {
        console.error(err);
        res.status(500).send(err);
      });
  });
  

  /**
 * @swagger
 * /get-flight-offers:
 *  get:
 *    description: Get flight offers
 *    parameters:
 *      - in: query
 *        name: origin
 *        schema:
 *          type: string
 *        required: true
 *        description: Origin location code
 *      - in: query
 *        name: destination
 *        schema:
 *          type: string
 *        required: true
 *        description: Destination location code
 *      - in: query
 *        name: departureDate
 *        schema:
 *          type: string
 *        required: true
 *        description: Departure date
 *      - in: query
 *        name: returnDate
 *        schema:
 *          type: string
 *        required: true
 *        description: Return date
 *      - in: query
 *        name: adults
 *        schema:
 *          type: integer
 *        required: false
 *        description: Number of adults
 *      - in: query
 *        name: travelClass
 *        schema:
 *          type: string
 *        required: false
 *        description: Travel class
 *    responses:
 *      '200':
 *        description: Successful response
 */

  app.get("/get-flight-offers", (req, res) => {
    getFlightOffers(
      req.query.origin,
      req.query.destination,
      req.query.departureDate,
      req.query.returnDate,
      req.query.adults || "1",
      req.query.travelClass || "ECONOMY"
    )
      .then((flights) => res.send(flights))
      .catch((err) => {
        console.error(err);
        res.status(500).send(err);
      });
  });



  /**
 * @swagger
 * /calendar-view:
 *  get:
 *    description: Get prices for calendar view
 *    parameters:
 *      - in: query
 *        name: origin
 *        schema:
 *          type: string
 *        required: true
 *        description: Origin location code
 *      - in: query
 *        name: destination
 *        schema:
 *          type: string
 *        required: true
 *        description: Destination location code
 *      - in: query
 *        name: departureDate
 *        schema:
 *          type: string
 *        required: true
 *        description: Departure date
 *      - in: query
 *        name: returnDate
 *        schema:
 *          type: string
 *        required: true
 *        description: Return date
 *      - in: query
 *        name: adults
 *        schema:
 *          type: integer
 *        required: false
 *        description: Number of adults
 *      - in: query
 *        name: travelClass
 *        schema:
 *          type: string
 *        required: false
 *        description: Travel class
 *    responses:
 *      '200':
 *        description: Successful response
 */

  app.get("/calendar-view", (req, res) => {
    let datepairs = generateCalendarDatepairs(req.query.departureDate, req.query.returnDate);
    pricesForDatepairs(
      req.query.origin,
      req.query.destination,
      req.query.adults || "1",
      req.query.travelClass || "ECONOMY",
      datepairs
    )
    .then((flights) => res.send(flights))
    .catch((err) => {
      res.status(500).send(err);
    });
  });
  

  /**
 * @swagger
 * /flights-for-datepairs:
 *  post:
 *    description: Get prices for datepairs
 *    parameters:
 *      - in: body
 *        name: origin
 *        schema:
 *          type: string
 *        required: true
 *        description: Origin location code
 *      - in: body
 *        name: destination
 *        schema:
 *          type: string
 *        required: true
 *        description: Destination location code
 *      - in: body
 *        name: adults
 *        schema:
 *          type: integer
 *        required: true
 *        description: Number of adults
 *      - in: body
 *        name: travelClass
 *        schema:
 *          type: string
 *        required: true
 *        description: Travel class
 *      - in: body
 *        name: datepairs
 *        schema:
 *          type: array
 *          items:
 *            type: string
 *        required: true
 *        description: Array of date pairs
 *    responses:
 *      '200':
 *        description: Successful response
 */
  app.post("/flights-for-datepairs", (req, res) => {
    pricesForDatepairs(
      req.body.origin,
      req.body.destination,
      req.body.adults,
      req.body.travelClass,
      req.body.datepairs
    )
    .then((flights) => res.send(flights))
    .catch((err) => {
      console.error(err);
      res.status(500).send(err);
    });
  });
  
