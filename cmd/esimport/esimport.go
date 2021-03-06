/* Copyright (c) 2016 Jason Ish
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED
 * WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT,
 * INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
 * STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
 * IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

package esimport

import (
	"encoding/json"
	"fmt"
	"github.com/jasonish/evebox/elasticsearch"
	"github.com/jasonish/evebox/eve"
	"github.com/jasonish/evebox/evereader"
	"github.com/jasonish/evebox/geoip"
	"github.com/jasonish/evebox/log"
	"github.com/jasonish/evebox/rules"
	"github.com/jasonish/evebox/useragent"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"io"
	"os"
	"time"
)

const DEFAULT_INDEX = "evebox"
const BATCH_SIZE = 1000

var flagset *pflag.FlagSet

var verbose = false
var stdout = false
var oneshot = false

func usage() {
	usage := `Usage: evebox esimport [options] /path/to/eve.json

Options:
`
	fmt.Fprint(os.Stderr, usage)
	flagset.PrintDefaults()
}

func configure(args []string) {

	viper.SetDefault("index", DEFAULT_INDEX)
	viper.SetDefault("disable-certificate-check", false)
	viper.SetDefault("geoip-enabled", true)

	flagset = pflag.NewFlagSet("esimport", 0)
	flagset.Usage = usage

	configFilename := flagset.StringP("config", "c", "", "Configuration file")

	flagset.BoolVarP(&verbose, "verbose", "v", false, "Verbose output")
	flagset.BoolVar(&oneshot, "oneshot", false, "One shot mode (exit on EOF)")
	flagset.BoolVar(&stdout, "stdout", false, "Print events to stdout")

	flagset.StringP("elasticsearch", "e", "", "Elastic Search URL")
	viper.BindPFlag("elasticsearch", flagset.Lookup("elasticsearch"))

	flagset.StringP("username", "u", "", "Username")
	viper.BindPFlag("username", flagset.Lookup("username"))

	flagset.StringP("password", "p", "", "Password")
	viper.BindPFlag("password", flagset.Lookup("password"))

	flagset.BoolP("no-check-certificate", "k", false, "Disable certificate check")
	viper.BindPFlag("disable-certificate-check", flagset.Lookup("no-check-certificate"))

	flagset.String("index", DEFAULT_INDEX, "Elastic Search index prefix")
	viper.BindPFlag("index", flagset.Lookup("index"))

	flagset.Bool("end", false, "Start at end of file")
	viper.BindPFlag("end", flagset.Lookup("end"))

	flagset.Bool("bookmark", false, "Enable bookmarking")
	viper.BindPFlag("bookmark", flagset.Lookup("bookmark"))

	bookmarkFilename := flagset.String("bookmark-filename", "", "Path to bookmark file")
	flagset.StringVar(bookmarkFilename, "bookmark-path", "", "Path to bookmark file")
	flagset.MarkHidden("bookmark-path")
	viper.BindPFlag("bookmark-filename", flagset.Lookup("bookmark-filename"))

	flagset.String("geoip-database", "", "Path to GeoIP (v2) database file")
	viper.BindPFlag("geoip.database-filename", flagset.Lookup("geoip-database"))

	flagset.String("rules", "", "Path to Suricata IDS rules")
	viper.BindPFlag("rules", flagset.Lookup("rules"))
	viper.BindEnv("rules", "ESIMPORT_RULES")

	flagset.Bool("force-template", false, "Force loading of template")
	viper.BindPFlag("force-template", flagset.Lookup("force-template"))

	flagset.String("doc-type", "", "Mapping type for events")
	viper.BindPFlag("doc-type", flagset.Lookup("doc-type"))

	if err := flagset.Parse(args[1:]); err != nil {
		if err == pflag.ErrHelp {
			os.Exit(0)
		}
		os.Exit(1)
	}

	if *configFilename != "" {
		log.Info("Using configuration file %s", *configFilename)
		viper.SetConfigFile(*configFilename)
		if err := viper.ReadInConfig(); err != nil {
			log.Fatal(err)
		}
	}

	if verbose {
		log.Info("Setting log level to debug")
		log.SetLevel(log.DEBUG)
	}

	if len(flagset.Args()) == 1 {
		viper.Set("input", flagset.Args()[0])
	} else if len(flagset.Args()) > 1 {
		log.Fatal("Multiple input filenames not allowed")
	}
}

func loadRuleMap() *rules.RuleMap {
	rulePatterns := viper.GetStringSlice("rules")
	rulemap := rules.NewRuleMap(rulePatterns)
	return rulemap
}

func Main(args []string) {

	configure(args)

	if viper.GetString("elasticsearch") == "" {
		log.Error("error: --elasticsearch is a required parameter")
		usage()
		os.Exit(1)
	}

	if viper.GetString("input") == "" {
		log.Fatal("error: no input file provided")
	}

	useBookmark := viper.GetBool("bookmark")
	bookmarkFilename := viper.GetString("bookmark-filename")

	if useBookmark && bookmarkFilename == "" {
		bookmarkFilename = fmt.Sprintf("%s.bookmark", viper.GetString("input"))
		log.Info("Using bookmark file %s", bookmarkFilename)
	}

	config := elasticsearch.Config{
		BaseURL:          viper.GetString("elasticsearch"),
		DisableCertCheck: viper.GetBool("disable-certificate-check"),
		Username:         viper.GetString("username"),
		Password:         viper.GetString("password"),
		ForceTemplate:    viper.GetBool("force-template"),
		DocType:          viper.GetString("doc-type"),
	}

	es := elasticsearch.New(config)
	es.EventIndexPrefix = viper.GetString("index")

	response, err := es.Ping()
	if err != nil {
		log.Fatal("error: failed to ping Elastic Search:", err)
	}
	log.Info("Connected to Elastic Search v%s (cluster:%s; name: %s)",
		response.Version.Number, response.ClusterName, response.Name)

	filters := make([]eve.EveFilter, 0)

	ruleMap := loadRuleMap()
	filters = append(filters, ruleMap)

	geoIpFilter := eve.NewGeoipFilter(geoip.NewGeoIpService())
	filters = append(filters, geoIpFilter)

	indexer := elasticsearch.NewIndexer(es)

	reader, err := evereader.NewFollowingReader(viper.GetString("input"))
	if err != nil {
		log.Fatal(err)
	}

	// Initialize bookmarking...
	var bookmarker *evereader.Bookmarker = nil
	optEnd := viper.GetBool("end")
	if useBookmark {
		bookmarker = &evereader.Bookmarker{
			Filename: bookmarkFilename,
			Reader:   reader,
		}
		err := bookmarker.Init(optEnd)
		if err != nil {
			log.Fatal(err)
		}
	} else if optEnd {
		log.Info("Jumping to end of file.")
		err := reader.SkipToEnd()
		if err != nil {
			log.Fatal(err)
		}
	}

	uaFilter := &useragent.EveUserAgentFilter{}
	filters = append(filters, uaFilter)

	tagsFilter := &eve.TagsFilter{}
	filters = append(filters, tagsFilter)

	count := uint64(0)
	lastStatTs := time.Now()
	lastStatCount := uint64(0)
	startTime := time.Now()

	// Number of EOFs in last stat interval.
	eofs := uint64(0)

	for {
		eof := false
		event, err := reader.Next()
		if err != nil {
			if err == io.EOF {
				eof = true
				eofs++
			} else if _, ok := err.(evereader.MalformedEventError); ok {
				log.Error("Failed to read event but will continue: %v", err)
			} else {
				log.Fatalf("Unrecoverable error reading event: %v", err)
			}
		}

		if event != nil {

			for _, filter := range filters {
				filter.Filter(event)
			}

			if stdout {
				asJson, err := json.Marshal(event)
				if err != nil {
					log.Error("Failed to print event as json: %v", err)
				} else {
					fmt.Println(string(asJson))
				}
			}

			indexer.Submit(event)
			count++
		}

		if eof || (count > 0 && count%BATCH_SIZE == 0) {
			status, err := indexer.Commit()
			if err != nil {
				log.Fatal(err)
			}
			if status != nil {
				response, ok := status.(*elasticsearch.Response)
				if ok {
					log.Debug("Indexed %d events {errors=%v}", len(response.Items),
						response.Errors)
				}
			}

			if useBookmark {
				bookmarker.UpdateBookmark()
			}
		}

		now := time.Now()
		if now.Sub(lastStatTs).Seconds() > 1 && now.Second() == 0 {

			// Calculate the lag in bytes, that is the number of bytes behind
			// the end of file we are.
			lag, err := reader.Lag()
			if err != nil {
				log.Error("Failed to calculate lag: %v", err)
			}

			log.Info("Total: %d; Last minute: %d; Avg: %.2f/s, EOFs: %d; Lag (bytes): %d",
				count,
				count-lastStatCount,
				float64(count-lastStatCount)/(now.Sub(lastStatTs).Seconds()),
				eofs,
				lag)
			lastStatTs = now
			lastStatCount = count
			eofs = 0
		}

		if eof {
			if oneshot {
				break
			} else {
				time.Sleep(1 * time.Second)
			}
		}
	}

	totalTime := time.Since(startTime)

	if oneshot {
		log.Info("Indexed %d events: time=%.2fs; avg=%d/s", count, totalTime.Seconds(),
			uint64(float64(count)/totalTime.Seconds()))
	}
}
